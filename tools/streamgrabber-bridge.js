#!/usr/bin/env node
// Streamgrabber bridge: lets the browser (Stremio Web) call the `streamgrabber` CLI.
//   GET  /grab?imdb=tt0096895&type=movie            -> JSON, stream_urls are signed /proxy URLs
//   GET  /grab?imdb=tt...&type=series&season=1&episode=2
//   GET|HEAD /proxy?url=<abs url>&exp=<unix>&sig=<hmac>   -> signed upstream fetch
//   GET  /health
//
// Hardening vs. the previous version:
//  - /proxy only serves URLs signed by this process (HMAC, expiring) -> no open proxy
//  - private / loopback / link-local / metadata addresses are blocked, re-checked on every redirect
//  - every async path is awaited, upstream errors become 502 and never crash the process
//  - CLI runs in its own process group and is killed whole on timeout
//  - bounded concurrency + queue, identical requests share one CLI run
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const env = process.env;
const cfg = {
    port: Number(env.PORT) || 7789,
    host: env.HOST || '127.0.0.1',
    cli: env.STREAMGRABBER_BIN || 'streamgrabber',
    cacheMs: Number(env.CACHE_MS) || 10 * 60 * 1000,
    cliTimeoutMs: Number(env.CLI_TIMEOUT_MS) || 45 * 1000,
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS) || 20 * 1000,
    maxRedirects: 5,
    maxConcurrent: Number(env.MAX_CONCURRENT) || 2,
    maxQueue: Number(env.MAX_QUEUE) || 3,
    maxPlaylistBytes: 5 * 1024 * 1024,
    maxCliOutput: 10 * 1024 * 1024,
    sigTtlMs: Number(env.SIGNATURE_TTL_MS) || 6 * 60 * 60 * 1000,
    publicBase: (env.PUBLIC_BASE || '').replace(/\/+$/, ''),
    proxyPublicPath: env.PROXY_PUBLIC_PATH || '/streamgrabber/proxy',
    allowOrigin: env.ALLOW_ORIGIN || '*',
    upstreamReferer: env.UPSTREAM_REFERER || '',
    allowPrivate: env.ALLOW_PRIVATE_UPSTREAM === '1', // tests only
};

const secretFromEnv = env.BRIDGE_SECRET;
if (!secretFromEnv && env.NODE_ENV === 'production') {
    console.error('BRIDGE_SECRET is required when NODE_ENV=production');
    process.exit(1);
}
const SECRET = secretFromEnv || crypto.randomBytes(32).toString('hex');
if (!secretFromEnv) console.warn('BRIDGE_SECRET not set: using a random secret (signed URLs break on restart)');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------- signing ----------
const sign = (url, exp) => crypto.createHmac('sha256', SECRET).update(`${exp}\n${url}`).digest('base64url');
const verify = (url, exp, sig) => {
    if (!/^\d+$/.test(exp || '') || !sig) return false;
    if (Number(exp) < Date.now()) return false;
    const a = Buffer.from(sign(url, exp));
    const b = Buffer.from(String(sig));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const signedUrl = (proxyBase, absolute) => {
    const exp = String(Date.now() + cfg.sigTtlMs);
    return `${proxyBase}?url=${encodeURIComponent(absolute)}&exp=${exp}&sig=${sign(absolute, exp)}`;
};

// ---------- SSRF guard ----------
const isPrivateIp = (ip) => {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (net.isIPv6(ip)) {
        const l = ip.toLowerCase();
        if (l === '::' || l === '::1') return true;
        if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
        return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
    }
    return true;
};
const guardedLookup = (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
        if (!cfg.allowPrivate && list.some((a) => isPrivateIp(a.address))) {
            return cb(new Error('blocked address'));
        }
        if (options && options.all) return cb(null, list);
        cb(null, list[0].address, list[0].family);
    });
};
const parseTarget = (str) => {
    let u;
    try { u = new URL(str); } catch (_) { throw new Error('invalid url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol');
    if (u.username || u.password) throw new Error('credentials in url not allowed');
    if (!cfg.allowPrivate && net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) {
        throw new Error('blocked address');
    }
    return u;
};

// ---------- upstream ----------
// Opens an upstream request, follows redirects manually (each hop re-validated),
// resolves with the final IncomingMessage (body not consumed).
const openUpstream = (urlStr, { method = 'GET', range, signal } = {}, depth = 0) => new Promise((resolve, reject) => {
    let u;
    try { u = parseTarget(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (range) headers.Range = range;
    if (cfg.upstreamReferer) headers.Referer = cfg.upstreamReferer;
    const req = lib.request(u, { method, headers, lookup: guardedLookup }, (r) => {
        const status = r.statusCode || 502;
        if (r.headers.location && status >= 300 && status < 400) {
            r.resume();
            if (depth >= cfg.maxRedirects) return reject(new Error('too many redirects'));
            let next;
            try { next = new URL(r.headers.location, u).href; } catch (_) { return reject(new Error('bad redirect')); }
            return openUpstream(next, { method, range, signal }, depth + 1).then(resolve, reject);
        }
        r.finalUrl = u.href;
        resolve(r);
    });
    req.on('error', reject);
    req.setTimeout(cfg.upstreamTimeoutMs, () => req.destroy(new Error('upstream timeout')));
    if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'));
        else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
});

const readBody = (r, limit) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    r.on('data', (c) => {
        size += c.length;
        if (size > limit) { r.destroy(); return reject(new Error('response too large')); }
        chunks.push(c);
    });
    r.on('end', () => resolve(Buffer.concat(chunks)));
    r.on('error', reject);
    r.on('aborted', () => reject(new Error('upstream aborted')));
});

// ---------- playlist ----------
// HLS playlists can be served under any extension or content type (e.g. page-0.html as
// text/plain), so decide by looking at the first bytes instead of trusting the URL.
const peek = (r, n = 16) => new Promise((resolve, reject) => {
    const done = () => {
        r.removeListener('readable', onReadable);
        r.removeListener('end', done);
        r.removeListener('error', fail);
        const buf = r.read();
        if (buf) r.unshift(buf);
        resolve(buf || Buffer.alloc(0));
    };
    const fail = (e) => { r.removeListener('readable', onReadable); r.removeListener('end', done); reject(e); };
    const onReadable = () => {
        // 'end' is only emitted once data is consumed, so also check the buffered-EOF flag.
        if (r.readableLength >= n || r.readableEnded || (r._readableState && r._readableState.ended)) done();
    };
    if (r.readableEnded) return done();
    r.on('readable', onReadable);
    r.once('end', done);
    r.once('error', fail);
    onReadable();
});
const isPlaylistBytes = (buf) => buf.toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
const canBePlaylist = (headers) => {
    const len = Number(headers['content-length']);
    return !(Number.isFinite(len) && len > cfg.maxPlaylistBytes);
};
// Native HLS players (iOS/iPadOS Safari, some Android WebViews) report an Infinity duration, and Stremio
// then shows a "live" stream, when a media playlist has no #EXT-X-ENDLIST. A playlist that declares itself
// VOD but lacks the end tag is just missing it, so add it back.
const ensureVodEnd = (text) => (
    /#EXTINF:/.test(text) && /^#EXT-X-PLAYLIST-TYPE:VOD\s*$/m.test(text) && !/#EXT-X-ENDLIST/.test(text) ?
        `${text.replace(/\s+$/, '')}\n#EXT-X-ENDLIST\n`
        :
        text
);
const rewritePlaylist = (text, baseUrl, proxyBase) => {
    text = ensureVodEnd(text);
    const toProxy = (t) => {
        let abs;
        try { abs = new URL(t, baseUrl).href; } catch (_) { return null; }
        if (!/^https?:/i.test(abs)) return null;
        return signedUrl(proxyBase, abs);
    };
    return text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (!t.startsWith('#')) return toProxy(t) || line;
        return line.replace(/URI="([^"]+)"/g, (m, target) => {
            const p = toProxy(target);
            return p ? `URI="${p}"` : m;
        });
    }).join('\n').replace(/\s*$/, '\n'); // playlists end with a newline; some native parsers want it
};

// ---------- CLI runner ----------
let running = 0;
const queue = [];
const cache = new Map();
const inflight = new Map();
const urlToGrabKey = new Map();

const runCli = (args) => new Promise((resolve, reject) => {
    const child = spawn(cfg.cli, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let errOut = '';
    let done = false;
    const killTree = () => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* gone */ } }
    };
    const finish = (fn, val) => { if (done) return; done = true; clearTimeout(timer); fn(val); };
    const timer = setTimeout(() => { killTree(); finish(reject, new Error('streamgrabber timed out')); }, cfg.cliTimeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > cfg.maxCliOutput) { killTree(); finish(reject, new Error('streamgrabber output too large')); } });
    child.stderr.on('data', (d) => { if (errOut.length < 4096) errOut += d; });
    child.on('error', (e) => finish(reject, new Error(`streamgrabber not available: ${e.message}`)));
    child.on('close', (code) => {
        if (code !== 0) return finish(reject, new Error(`streamgrabber failed (${code}): ${errOut.trim().slice(0, 300)}`));
        const s = out.indexOf('{');
        const e = out.lastIndexOf('}');
        if (s === -1 || e === -1) return finish(reject, new Error('No JSON in streamgrabber output'));
        try { finish(resolve, JSON.parse(out.slice(s, e + 1))); } catch (x) { finish(reject, x); }
    });
});

const schedule = (args) => new Promise((resolve, reject) => {
    const start = () => {
        running += 1;
        runCli(args).then(resolve, reject).finally(() => {
            running -= 1;
            const next = queue.shift();
            if (next) next();
        });
    };
    if (running < cfg.maxConcurrent) return start();
    if (queue.length >= cfg.maxQueue) { const e = new Error('server busy'); e.status = 503; return reject(e); }
    queue.push(start);
});

// fresh=true skips the in-memory result (the client retries with it after a playback failure).
const grab = ({ imdb, type, season, episode, fresh = false }) => {
    const key = [imdb, type, season, episode].join('|');
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < cfg.cacheMs) return Promise.resolve(hit.data);
    if (inflight.has(key)) return inflight.get(key);
    const args = [`https://www.imdb.com/title/${imdb}`];
    if (type === 'series') args.push('--season', String(season), '--episode', String(episode));
    args.push('--stream-url');
    const p = schedule(args).then((data) => {
        cache.set(key, { at: Date.now(), data });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        const urls = Array.isArray(data?.stream_urls) ? data.stream_urls : [];
        for (const u of urls) urlToGrabKey.set(u, key);
        while (urlToGrabKey.size > 2000) urlToGrabKey.delete(urlToGrabKey.keys().next().value);
        return data;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
};
const evictGrabCacheForUrl = (target) => {
    const key = urlToGrabKey.get(target);
    if (key) { cache.delete(key); urlToGrabKey.delete(target); }
};

// ---------- http ----------
const corsHeaders = () => ({
    'Access-Control-Allow-Origin': cfg.allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
});
const sendJson = (res, code, body) => {
    if (res.headersSent) return res.end();
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders() });
    res.end(JSON.stringify(body));
};
const getPublicBase = (req) => {
    if (cfg.publicBase) return cfg.publicBase;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
        String(req.headers['cf-visitor'] || '').includes('https') ? 'https' : 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return '';
    return `${proto}://${host}`;
};

// A client or addon may wrap one of our already-signed URLs in a second, unsigned /proxy URL
// (proxy?url=<signed proxy url>). Never an open proxy: only serve it if the INNER URL carries a
// valid signature, and then serve the inner one.
const resolveTarget = (url) => {
    let target = url.searchParams.get('url');
    if (verify(target, url.searchParams.get('exp'), url.searchParams.get('sig'))) return target;
    for (let i = 0; i < 3 && target; i++) {
        let u;
        try { u = new URL(target); } catch (_) { return null; }
        if (u.pathname !== cfg.proxyPublicPath) return null;
        const inner = u.searchParams.get('url');
        if (inner && verify(inner, u.searchParams.get('exp'), u.searchParams.get('sig'))) return inner;
        target = inner;
    }
    return null;
};

// Playlists are small and must be rewritten whole, so never serve a byte range of one. iOS/AVFoundation
// probes the first request with "Range: bytes=0-1"; answering that with 2 raw, unrewritten bytes (and the
// upstream's wrong Content-Type) leaves the native player loading forever. A plain 200 is always valid.
const isPlaylistUrl = (u) => {
    try { return /\.m3u8$/i.test(new URL(u).pathname); } catch (_) { return false; }
};

const handleProxy = async (req, res, url) => {
    if (!url.searchParams.get('url')) return sendJson(res, 400, { error: 'missing url param' });
    const target = resolveTarget(url);
    if (!target) {
        return sendJson(res, 403, { error: 'invalid or expired signature' });
    }
    const proxyBase = `${getPublicBase(req)}${cfg.proxyPublicPath}`;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const isHead = req.method === 'HEAD';
    let upstream;
    try {
        upstream = await openUpstream(target, { method: isHead ? 'HEAD' : 'GET', range: isPlaylistUrl(target) ? undefined : req.headers.range, signal: ac.signal });
    } catch (e) {
        return sendJson(res, e.message === 'blocked address' ? 403 : 502, { error: e.message });
    }
    const status = upstream.statusCode || 502;
    if ([403, 404, 410].includes(status) && isPlaylistUrl(target)) evictGrabCacheForUrl(target);
    const ct = upstream.headers['content-type'] || '';
    try {
        if (isHead) {
            const h = { ...corsHeaders() };
            for (const k of ['content-type', 'content-length', 'accept-ranges', 'last-modified', 'etag']) {
                if (upstream.headers[k]) h[k] = upstream.headers[k];
            }
            // The player decides HLS vs. plain video from this HEAD's Content-Type, and our URL has no
            // .m3u8 extension. Upstream often labels playlists text/html, text/plain or octet-stream (or
            // rejects HEAD), so sniff the body with a tiny GET and report the playlist type ourselves.
            if (status < 300 && !/mpegurl|mp2t/i.test(ct) && (canBePlaylist(upstream.headers) || /^text\//i.test(ct))) {
                upstream.destroy();
                try {
                    const probe = await openUpstream(target, { method: 'GET', signal: ac.signal });
                    const head = probe.statusCode < 300 ? await peek(probe) : Buffer.alloc(0);
                    probe.destroy();
                    if (isPlaylistBytes(head)) {
                        h['content-type'] = 'application/vnd.apple.mpegurl';
                        delete h['content-length'];
                    } else if (head.length && head[0] === 0x47 && /^text\//i.test(ct)) {
                        h['content-type'] = 'video/mp2t'; // TS segment disguised as a page
                    }
                } catch (_) { /* keep upstream headers */ }
            } else {
                upstream.resume();
            }
            if (isPlaylistUrl(target)) h['Cache-Control'] = 'no-cache';
            if (status >= 400) h['Cache-Control'] = 'no-store';
            res.writeHead(status, h);
            return res.end();
        }
        // Playlist? Sniff the first bytes (only for responses small enough to be one).
        if (status < 300 && canBePlaylist(upstream.headers) && !upstream.headers['content-range']) {
            const head = await peek(upstream);
            if (isPlaylistBytes(head)) {
                const body = await readBody(upstream, cfg.maxPlaylistBytes);
                const out = Buffer.from(rewritePlaylist(body.toString('utf8'), upstream.finalUrl, proxyBase), 'utf8');
                res.writeHead(status, { ...corsHeaders(), 'Content-Type': /mpegurl/i.test(ct) ? ct : 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache', 'Content-Length': out.length });
                return res.end(out);
            }
            // Segments disguised as pages (e.g. page-0.html served as text/html) but starting with the
            // MPEG-TS sync byte: report the real type so strict players accept them.
            if (head.length && head[0] === 0x47 && /^text\//i.test(ct)) {
                const h2 = { ...corsHeaders(), 'Content-Type': 'video/mp2t' };
                for (const k of ['content-length', 'accept-ranges', 'last-modified', 'cache-control', 'etag']) {
                    if (upstream.headers[k]) h2[k] = upstream.headers[k];
                }
                res.writeHead(status, h2);
                upstream.on('error', () => res.destroy());
                upstream.pipe(res);
                res.on('close', () => upstream.destroy());
                return;
            }
        } else if (status >= 400 && canBePlaylist(upstream.headers)) {
            // e.g. an HTML 403 served at a .m3u8 URL: pass it through untouched.
            const body = await readBody(upstream, cfg.maxPlaylistBytes);
            res.writeHead(status, { ...corsHeaders(), 'Content-Type': ct || 'text/plain', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
            return res.end(body);
        }
        const h = { ...corsHeaders() };
        for (const k of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified', 'cache-control', 'etag']) {
            if (upstream.headers[k]) h[k] = upstream.headers[k];
        }
        if (status >= 400) h['Cache-Control'] = 'no-store';
        res.writeHead(status, h);
        upstream.on('error', () => res.destroy());
        upstream.pipe(res);
        res.on('close', () => upstream.destroy());
    } catch (e) {
        if (!res.headersSent) return sendJson(res, 502, { error: e.message });
        res.destroy();
    }
};

const handleGrab = async (req, res, url) => {
    const imdb = url.searchParams.get('imdb') || '';
    const type = url.searchParams.get('type') === 'series' ? 'series' : 'movie';
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    if (!/^tt\d{1,12}$/.test(imdb)) return sendJson(res, 400, { error: 'bad imdb id' });
    if (type === 'series' && !(/^\d{1,4}$/.test(season || '') && /^\d{1,5}$/.test(episode || ''))) {
        return sendJson(res, 400, { error: 'season/episode required' });
    }
    try {
        const data = await grab({ imdb, type, season, episode, fresh: url.searchParams.get('fresh') === '1' });
        const urls = (Array.isArray(data.stream_urls) ? data.stream_urls : []).filter((u) => { try { parseTarget(u); return true; } catch (_) { return false; } });
        if (urls.length === 0) return sendJson(res, 502, { error: 'no stream urls' });
        const proxyBase = `${getPublicBase(req)}${cfg.proxyPublicPath}`;
        sendJson(res, 200, { ...data, stream_urls: urls.map((u) => signedUrl(proxyBase, u)) });
    } catch (e) {
        sendJson(res, e.status || 502, { error: e.message });
    }
};

const server = http.createServer((req, res) => {
    const handle = async () => {
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return sendJson(res, 400, { error: 'bad request' }); }
        if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok', running, queued: queue.length });
        if (url.pathname === '/proxy') return handleProxy(req, res, url);
        if (url.pathname === '/grab') return handleGrab(req, res, url);
        return sendJson(res, 404, { error: 'not found' });
    };
    handle().catch((e) => { console.error('unhandled handler error:', e); sendJson(res, 500, { error: 'internal error' }); });
});
server.requestTimeout = 0; // media streams are long-lived
server.headersTimeout = 15000;

// A rejected promise is logged and the process keeps serving. A truly uncaught
// exception leaves unknown state, so log and exit and let systemd restart cleanly.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e); process.exit(1); });
server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use (stop the old bridge unit)` : `server error: ${e.message}`);
    process.exit(1);
});

if (require.main === module) {
    server.listen(cfg.port, cfg.host, () => process.stdout.write(`streamgrabber bridge on http://${cfg.host}:${cfg.port}\n`));
}
module.exports = { server, sign, verify, rewritePlaylist, ensureVodEnd, isPrivateIp };
