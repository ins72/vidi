// Copyright (C) 2017-2026 Smart code 203358507
//
// sg-service: streamgrabber-backed stream resolver.
//
// Exposes the same /resolve/{contentId}?season=&episode= contract as the
// previous vidfind-service, but resolves streams exclusively via the
// streamgrabber CLI (`streamgrabber --stream-url`) and returns the raw
// CDN HLS URL directly (no HTML player wrapper, no proxy hop).
//
//   GET /resolve/{contentId}?season=1&episode=2
//   -> { imdbId, contentId, season, episode, hlsUrl, title, subtitles }

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execFile } = require('child_process');

const PORT = process.env.SG_PORT || process.env.VIDFIND_PORT || 3999;
const STREAMGRABBER_BIN = process.env.SG_BIN || 'streamgrabber';
const REQUEST_TIMEOUT_MS = parseInt(process.env.SG_TIMEOUT_MS || '45000', 10);
const PROXY_TIMEOUT_MS = parseInt(process.env.SG_PROXY_TIMEOUT_MS || '30000', 10);
const PROXY_BASE = process.env.SG_PROXY_BASE || null; // derived per-request when unset
const NO_CACHE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
};

const isImDbId = (v) => typeof v === 'string' && /^tt\d+/i.test(v);

const parseStreamgrabberOutput = (stdout) => {
    const start = stdout.indexOf('{');
    if (start === -1) {
        throw new Error('streamgrabber produced no JSON output');
    }
    return JSON.parse(stdout.slice(start));
};

const buildArgs = (contentId, season, episode) => {
    // streamgrabber accepts bare IMDb IDs (e.g. tt26657236) or full URLs.
    // TMDB numeric IDs are not understood by streamgrabber's resolvers, so
    // only IMDb IDs are supported here.
    let url;
    if (isImDbId(contentId)) {
        url = `https://www.imdb.com/title/${contentId}`;
    } else if (/^https?:\/\//i.test(contentId)) {
        url = contentId;
    } else {
        throw new Error(`Unsupported contentId: ${contentId}`);
    }
    const args = [url, '--stream-url'];
    if (season !== null && season !== undefined && season !== '') {
        args.push('--season', String(season));
    }
    if (episode !== null && episode !== undefined && episode !== '') {
        args.push('--episode', String(episode));
    }
    return args;
};

const resolveContentId = (contentId, season, episode, proxyBase) => new Promise((resolve, reject) => {
    let args;
    try {
        args = buildArgs(contentId, season, episode);
    } catch (err) {
        return reject(err);
    }

    const child = execFile(STREAMGRABBER_BIN, args, {
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env }
    }, (err, stdout, stderr) => {
        if (err) {
            const detail = (stderr || stdout || '').trim().slice(0, 500);
            return reject(new Error(`streamgrabber failed: ${err.message}${detail ? ` | ${detail}` : ''}`));
        }
        try {
            const data = parseStreamgrabberOutput(stdout);
            const urls = Array.isArray(data.stream_urls) ? data.stream_urls : [];
            if (urls.length === 0) {
                return reject(new Error('streamgrabber returned no stream URLs'));
            }
            const base = proxyBase || `http://127.0.0.1:${PORT}`;
            resolve({
                imdbId: data.media_id || contentId,
                contentId,
                season: season !== null && season !== undefined && season !== '' ? parseInt(season, 10) : null,
                episode: episode !== null && episode !== undefined && episode !== '' ? parseInt(episode, 10) : null,
                hlsUrl: `${base}${PROXY_PATH_PREFIX}?url=${encodeURIComponent(urls[0])}`,
                hlsUrlDirect: urls[0],
                hlsUrls: urls.map((u) => `${base}${PROXY_PATH_PREFIX}?url=${encodeURIComponent(u)}`),
                title: data.title || null,
                mediaType: data.media_type || null,
                subtitles: []
            });
        } catch (parseErr) {
            reject(parseErr);
        }
    });

    child.on('error', (err) => reject(new Error(`streamgrabber binary not available: ${err.message}`)));
});

const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        // Never let a CDN/proxy cache the resolved stream URL — it changes per
        // request and must always reflect a fresh streamgrabber run.
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(body);
};

// ---------------------------------------------------------------------------
// Stream proxy
//
// The HLS playlists/segments returned by the CDN are proxied through this
// service so the browser never talks to the third-party CDN directly. The
// master m3u8 is rewritten on the fly so every variant + segment URL becomes
// relative to the sg-service itself, keeping CORS/CSP happy and allowing the
// server to cache segments if a reverse proxy is placed in front.
// ---------------------------------------------------------------------------

const PROXY_PATH_PREFIX = '/sg/proxy/stream';
const PROXY_PATH_RE = /^\/proxy\/stream(?:\/(.*))?$/;

const net = require('net');
const isPrivateHost = (h) => {
    const x = h.replace(/^\[|\]$/g, '').toLowerCase();
    if (x === 'localhost' || x.endsWith('.localhost') || x.endsWith('.internal')) return true;
    if (net.isIPv4(x)) {
        const [a, b] = x.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
    }
    return net.isIPv6(x) && (x === '::1' || x === '::' || /^f[cde]/.test(x) || x.startsWith('::ffff:'));
};

const isHlsUrl = (u) => typeof u === 'string' && /^https?:\/\/.+/i.test(u);

const rewriteHlsBody = (body, targetUrl) => {
    if (!body) return body;
    const base = new URL(targetUrl);
    const out = [];
    for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            out.push(raw);
            continue;
        }
        if (line.startsWith('#')) {
            out.push(raw.replace(/URI="([^"]+)"/g, (m, target) => {
                try {
                    const parsed = new URL(target, base.href);
                    return `URI="${PROXY_PATH_PREFIX}${parsed.pathname}?url=${encodeURIComponent(parsed.href)}"`;
                } catch {
                    return m;
                }
            }));
            continue;
        }
        let rewritten = line;
        try {
            const parsed = new URL(line, base.href);
            // Route every playlist/segment URL through our proxy so the browser
            // never talks to the third-party CDN directly. Preserve the full
            // original path (including subpaths like /content/.../page-0.html).
            // Only the pathname is mirrored (keeps the file extension for players);
            // the full original URL, query string included, lives in ?url=.
            rewritten = `${PROXY_PATH_PREFIX}${parsed.pathname}?url=${encodeURIComponent(parsed.href)}`;
        } catch {
            // Not a URL — leave untouched.
        }
        out.push(rewritten);
    }
    return out.join('\n');
};

const proxyFetch = (targetUrl, signal, depth = 0) => new Promise((resolve, reject) => {
    if (depth > 10) {
        return reject(new Error('Too many redirects'));
    }
    const u = new URL(targetUrl);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isPrivateHost(u.hostname)) {
        return reject(new Error('Blocked upstream'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
        {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (sg-service stream proxy)',
                Accept: '*/*'
            }
        },
        (res) => {
            // Follow redirects (CDN often 301/302 between http/https or paths).
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
                res.resume();
                return proxyFetch(new URL(res.headers.location, targetUrl), signal, depth + 1).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({ status: res.statusCode || 200, headers: res.headers, body: Buffer.concat(chunks) });
            });
        }
    );
    req.on('error', reject);
    if (signal) {
        signal.addEventListener('abort', () => { req.destroy(new Error('aborted')); });
    }
    req.end();
});

const handleProxy = async (req, res, targetUrl) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    const isHead = req.method === 'HEAD';
    try {
        const { status, headers, body } = await proxyFetch(targetUrl, controller.signal);
        const ct = (headers['content-type'] || '').toLowerCase();
        const isPlaylist = ct.includes('application/vnd.apple.mpegurl') || ct.includes('text/plain') || targetUrl.endsWith('.m3u8');
        const outHeaders = {
            'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : (ct || 'application/octet-stream'),
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            ...NO_CACHE_HEADERS
        };
        if (isPlaylist) {
            // HEAD requests must not include the rewritten body — only headers.
            const outBody = isHead ? Buffer.alloc(0) : Buffer.from(rewriteHlsBody(body.toString('utf-8'), targetUrl));
            outHeaders['Content-Length'] = Buffer.byteLength(outBody);
            res.writeHead(status, outHeaders);
            res.end(outBody);
        } else if (isHead) {
            // Non-playlist HEAD: report upstream length without sending the body.
            if (headers['content-length']) outHeaders['Content-Length'] = headers['content-length'];
            res.writeHead(status, outHeaders);
            res.end();
        } else if (headers['content-length']) {
            outHeaders['Content-Length'] = headers['content-length'];
            res.writeHead(status, outHeaders);
            res.end(body);
        } else {
            res.writeHead(status, outHeaders);
            res.end(body);
        }
    } catch (err) {
        console.error('[sg-service] proxy error:', err.message);
        if (!res.headersSent) {
            sendJson(res, 502, { error: 'Upstream fetch failed', detail: err.message });
        }
    } finally {
        clearTimeout(timer);
    }
};

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    // The video player probes stream content type with a HEAD request before
    // issuing the actual GET. The sg-service proxies the upstream fetch, so a
    // HEAD must be answered with the same headers a GET would return — without
    // the response body. Without this the probe fails with 405 and playback
    // never starts.
    const isHead = req.method === 'HEAD';

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method !== 'GET' && !isHead) {
        return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', resolver: 'streamgrabber' });
    }

    // Proxy a remote HLS playlist/segment through this service.
    //   GET /proxy/stream?url=<encoded remote m3u8 or segment URL>
    //   GET /proxy/stream/<any path>?url=<encoded remote m3u8 or segment URL>
    const proxyMatch = url.pathname.match(PROXY_PATH_RE);
    if (proxyMatch) {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            return sendJson(res, 400, { error: 'Missing url parameter' });
        }
        return handleProxy(req, res, targetUrl);
    }

    const match = url.pathname.match(/^(?:\/(?:vidfind|sg))?\/resolve\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
        return sendJson(res, 400, { error: 'Invalid path. Expected /resolve/{contentId}' });
    }

    let contentId;
    try {
        contentId = decodeURIComponent(match[1]);
    } catch (_) {
        return sendJson(res, 400, { error: 'Malformed contentId' });
    }
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    // Build the proxy base from the incoming request so the returned HLS URL
    // points back at the same host the client used (works behind nginx/CF).
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    // Cloudflare terminates TLS and re-origins over HTTP, stripping
    // X-Forwarded-Proto. The CF-Visitor header ("scheme=https") is reliable
    // when the request came through CF; fall back to X-Forwarded-Proto then
    // plain http for direct/local access.
    const cfVisitor = (req.headers['cf-visitor'] || '').toLowerCase();
    const scheme = cfVisitor.includes('https') || req.headers['x-forwarded-proto'] === 'https'
        ? 'https'
        : 'http';
    const proxyBase = `${scheme}://${host}`;

    resolveContentId(contentId, season, episode, proxyBase)
        .then((data) => sendJson(res, 200, data))
        .catch((err) => {
            console.error('[sg-service] resolve error:', err.message);
            sendJson(res, 400, { error: err.message || 'Failed to resolve stream' });
        });
});

server.listen(PORT, process.env.SG_HOST || '127.0.0.1', () => {
    console.log(`sg-service (streamgrabber) listening on port ${PORT}`);
});
