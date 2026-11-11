#!/usr/bin/env node
// Self-contained test for tools/streamgrabber-bridge.js (no dependencies).
// Run: node tools/test/bridge-selftest.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const BRIDGE = path.resolve(__dirname, '..', 'streamgrabber-bridge.js');
const SECRET = 'test-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgtest-'));
const counter = path.join(tmp, 'runs.log');
let passed = 0;
const failures = [];
const children = [];

const test = async (name, fn) => {
    try {
        await fn();
        passed++;
        process.stdout.write('  ok   ' + name + '\n');
    } catch (e) {
        failures.push(name);
        process.stdout.write('  FAIL ' + name + '\n       ' + (e.stack || e) + '\n');
    }
};
const sign = (url, exp) => crypto.createHmac('sha256', SECRET).update(`${exp}\n${url}`).digest('base64url');
const signed = (port, url, expOffset = 3600000) => {
    const exp = String(Date.now() + expOffset);
    return `http://127.0.0.1:${port}/proxy?url=${encodeURIComponent(url)}&exp=${exp}&sig=${sign(url, exp)}`;
};
const get = (url, opts = {}) => new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {}, timeout: 15000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    req.on('error', reject);
    req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake CLI ----
const cli = path.join(tmp, 'fakecli.sh');
const writeCli = (cdnPort) => fs.writeFileSync(cli, `#!/bin/bash
echo "$@" >> ${counter}
case "$*" in
  *tt9999991*) sleep 4321 & sleep 4321; exit 0;;
  *tt9999992*) echo "boom" >&2; exit 3;;
  *tt9999993*) echo "no json here"; exit 0;;
esac
sleep \${FAKE_DELAY:-0}
echo 'noise before'
echo '{"media_id":"x","title":"T","stream_urls":["http://127.0.0.1:${cdnPort}/master.m3u8?token=abc"]}'
`, { mode: 0o755 });

// ---- fake CDN ----
const cdn = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/master.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8?sig=1&b=2\n');
    }
    if (u.pathname === '/variant.m3u8') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?k=1"\n#EXTINF:4,\nseg1.ts?s=1\n#EXTINF:4,\nhttp://127.0.0.1:' + cdn.address().port + '/seg2.ts\n#EXT-X-ENDLIST\n');
    }
    if (u.pathname === '/seg1.ts') {
        const data = Buffer.alloc(1000, 7);
        if (req.headers.range) {
            res.writeHead(206, { 'content-range': 'bytes 0-99/1000', 'content-length': 100, 'accept-ranges': 'bytes' });
            return res.end(data.slice(0, 100));
        }
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': 1000, 'accept-ranges': 'bytes' });
        return req.method === 'HEAD' ? res.end() : res.end(data);
    }
    if (u.pathname === '/page-0.html') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('\uFEFF#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1:' + cdn.address().port + '/seg2.ts\n'); }
    if (u.pathname === '/disguised.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); return setTimeout(() => res.end(Buffer.alloc(5000, 1)), 50); }
    if (u.pathname === '/empty') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 0 }); return res.end(); }
    if (u.pathname === '/seg2.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('seg2'); }
    if (u.pathname === '/html403.m3u8') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<html>nope</html>'); }
    if (u.pathname === '/redir-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    if (u.pathname === '/reset') { req.socket.destroy(); return; }
    if (u.pathname === '/midreset') {
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': 100000 });
        res.write('abc');
        setTimeout(() => req.socket.destroy(), 100);
        return;
    }
    res.writeHead(404);
    res.end('nf');
});

const startBridge = (port, extra = {}) => new Promise((resolve, reject) => {
    const p = spawn('node', [BRIDGE], {
        env: { ...process.env, PORT: String(port), BRIDGE_SECRET: SECRET, STREAMGRABBER_BIN: cli, ALLOW_PRIVATE_UPSTREAM: '1', PROXY_PUBLIC_PATH: '/proxy', PUBLIC_BASE: `http://127.0.0.1:${port}`, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(p);
    let log = '';
    p.stdout.on('data', (d) => { log += d; if (log.includes('bridge on')) resolve(p); });
    p.stderr.on('data', (d) => { log += d; });
    p.on('exit', () => { p.exited = true; });
    setTimeout(() => reject(new Error('bridge start timeout: ' + log)), 5000);
});

const main = async () => {
    await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
    const cdnPort = cdn.address().port;
    writeCli(cdnPort);
    const P = 18789;
    const b = await startBridge(P, { CLI_TIMEOUT_MS: '1500', MAX_CONCURRENT: '2', MAX_QUEUE: '3' });
    const base = `http://127.0.0.1:${P}`;
    let master;

    await test('health, 404, bad method, bad params', async () => {
        assert.strictEqual((await get(base + '/health')).status, 200);
        assert.strictEqual((await get(base + '/nope')).status, 404);
        assert.strictEqual((await get(base + '/grab', { method: 'POST' })).status, 405);
        assert.strictEqual((await get(base + '/grab?imdb=bad&type=movie')).status, 400);
        assert.strictEqual((await get(base + '/grab?imdb=tt1&type=series&season=a&episode=1')).status, 400);
    });
    await test('/grab returns signed proxy urls', async () => {
        const r = await get(base + '/grab?imdb=tt0000001&type=movie');
        assert.strictEqual(r.status, 200);
        master = JSON.parse(r.body).stream_urls[0];
        assert.ok(master.startsWith(`http://127.0.0.1:${P}/proxy?url=`) && master.includes('&sig=') && master.includes('&exp='));
    });
    await test('/proxy rejects unsigned, tampered and expired', async () => {
        const target = `http://127.0.0.1:${cdnPort}/seg2.ts`;
        assert.strictEqual((await get(`${base}/proxy?url=${encodeURIComponent(target)}`)).status, 403);
        const ok = signed(P, target);
        assert.strictEqual((await get(ok)).status, 200);
        assert.strictEqual((await get(ok.replace('seg2', 'seg1'))).status, 403);
        assert.strictEqual((await get(signed(P, target, -1000))).status, 403);
        assert.strictEqual((await get(`${base}/proxy`)).status, 400);
    });
    await test('playlist rewrite: query strings, key URI, absolute urls, text/plain content-type', async () => {
        const m = await get(master);
        assert.strictEqual(m.status, 200);
        const variantLine = m.body.split('\n').find((l) => l.includes('/proxy?url='));
        assert.ok(decodeURIComponent(variantLine).includes('variant.m3u8?sig=1&b=2'));
        const v = await get(variantLine);
        assert.strictEqual(v.status, 200);
        const lines = v.body.split('\n');
        assert.strictEqual(lines.filter((l) => l.startsWith(`http://127.0.0.1:${P}/proxy?url=`)).length, 2);
        assert.ok(new RegExp(`URI="http://127\\.0\\.0\\.1:${P}/proxy\\?url=`).test(v.body));
        const seg = lines.find((l) => decodeURIComponent(l).includes('seg1.ts?s=1'));
        assert.ok(seg);
        const s = await get(seg);
        assert.strictEqual(s.status, 200);
        assert.strictEqual(s.body.length, 1000);
    });
    await test('Range and HEAD passthrough', async () => {
        const u = signed(P, `http://127.0.0.1:${cdnPort}/seg1.ts?s=1`);
        const r = await get(u, { headers: { Range: 'bytes=0-99' } });
        assert.strictEqual(r.status, 206);
        assert.strictEqual(r.body.length, 100);
        const h = await get(u, { method: 'HEAD' });
        assert.strictEqual(h.status, 200);
        assert.strictEqual(h.headers['content-length'], '1000');
        assert.strictEqual(h.body.length, 0);
    });
    await test('playlist under a non-.m3u8 URL (text/plain, BOM) is rewritten; binary and empty bodies pass through', async () => {
        const p = await get(signed(P, `http://127.0.0.1:${cdnPort}/page-0.html`));
        assert.strictEqual(p.status, 200);
        assert.ok(p.body.includes(`http://127.0.0.1:${P}/proxy?url=`) && !p.body.includes('/seg2.ts\n'.replace('\n', '')) === false || p.body.includes('/proxy?url='));
        assert.ok(!/^http:\/\/127\.0\.0\.1:\d+\/seg2\.ts/m.test(p.body), 'segment url must not be left direct');
        const j = await get(signed(P, `http://127.0.0.1:${cdnPort}/disguised.jpg`));
        assert.strictEqual(j.status, 200);
        assert.strictEqual(j.headers['content-type'], 'image/jpeg');
        assert.strictEqual(j.body.length > 1000, true);
        const e = await get(signed(P, `http://127.0.0.1:${cdnPort}/empty`));
        assert.strictEqual(e.status, 200);
        assert.strictEqual(e.body.length, 0);
    });
    await test('HTML 403 served at .m3u8 is passed through unmangled', async () => {
        const r = await get(signed(P, `http://127.0.0.1:${cdnPort}/html403.m3u8`));
        assert.strictEqual(r.status, 403);
        assert.ok(r.body.includes('<html>'));
    });
    await test('bad upstreams give 502 and the process survives', async () => {
        const bad = ['file:///etc/passwd', 'http://127.0.0.1:1/x.ts', 'http://no-such-host.invalid/x.ts', 'not a url', `http://127.0.0.1:${cdnPort}/reset`, `http://127.0.0.1:${cdnPort}/redir-file`];
        for (const t of bad) {
            const r = await get(signed(P, t));
            assert.strictEqual(r.status, 502, t + ' -> ' + r.status);
        }
        assert.strictEqual((await get(base + '/health')).status, 200);
        assert.ok(!b.exited);
    });
    await test('upstream reset mid-stream and client abort do not crash', async () => {
        await get(signed(P, `http://127.0.0.1:${cdnPort}/midreset`)).catch(() => null);
        await new Promise((resolve) => {
            const r = http.get(signed(P, `http://127.0.0.1:${cdnPort}/midreset`), (res) => { res.once('data', () => { r.destroy(); resolve(); }); });
            r.on('error', () => resolve());
        });
        await sleep(300);
        assert.strictEqual((await get(base + '/health')).status, 200);
        assert.ok(!b.exited);
    });
    await test('CLI failures (exit code, no JSON) give 502', async () => {
        assert.strictEqual((await get(base + '/grab?imdb=tt9999992&type=movie')).status, 502);
        assert.strictEqual((await get(base + '/grab?imdb=tt9999993&type=movie')).status, 502);
    });
    await test('CLI timeout kills the whole process tree', async () => {
        const r = await get(base + '/grab?imdb=tt9999991&type=movie');
        assert.strictEqual(r.status, 502);
        assert.ok(/timed out/.test(r.body));
        await sleep(300);
        const left = execSync('pgrep -x sleep -a || true').toString().split('\n').filter((l) => l.includes('4321')).join();
        assert.strictEqual(left, '', 'orphan sleep still running: ' + left);
    });
    await test('SSRF: private addresses blocked when ALLOW_PRIVATE_UPSTREAM is off', async () => {
        const P2 = 18790;
        const b2 = await startBridge(P2, { ALLOW_PRIVATE_UPSTREAM: '0' });
        for (const t of [`http://127.0.0.1:${cdnPort}/seg2.ts`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/x', 'http://[::1]/x', `http://localhost:${cdnPort}/seg2.ts`, 'http://2130706433/x']) {
            const r = await get(signed(P2, t));
            assert.ok(r.status === 403 || r.status === 502, t + ' -> ' + r.status);
            assert.ok(!r.body.includes('seg2'));
        }
        b2.kill();
    });
    await test('concurrency: 2 run, 3 queue, rest 503; duplicates share one run', async () => {
        const P3 = 18791;
        const b3 = await startBridge(P3, { FAKE_DELAY: '1', MAX_CONCURRENT: '2', MAX_QUEUE: '3', CLI_TIMEOUT_MS: '10000' });
        const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => get(`http://127.0.0.1:${P3}/grab?imdb=tt${2000 + i}&type=movie`)));
        const codes = rs.map((r) => r.status);
        assert.strictEqual(codes.filter((c) => c === 200).length, 5, codes.join());
        assert.strictEqual(codes.filter((c) => c === 503).length, 3, codes.join());
        fs.writeFileSync(counter, '');
        await Promise.all(Array.from({ length: 5 }, () => get(`http://127.0.0.1:${P3}/grab?imdb=tt5555&type=movie`)));
        assert.strictEqual(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
        b3.kill();
    });
    await test('series args reach the CLI', async () => {
        fs.writeFileSync(counter, '');
        await get(base + '/grab?imdb=tt7777&type=series&season=2&episode=3');
        assert.ok(/--season 2 --episode 3 --stream-url/.test(fs.readFileSync(counter, 'utf8')));
    });
    await test('exits non-zero when the port is taken (no zombie process)', async () => {
        const code = await new Promise((resolve) => {
            const p = spawn('node', [BRIDGE], { env: { ...process.env, PORT: String(P), BRIDGE_SECRET: SECRET }, stdio: 'ignore' });
            const t = setTimeout(() => { p.kill('SIGKILL'); resolve('still running'); }, 5000);
            p.on('exit', (c) => { clearTimeout(t); resolve(c); });
        });
        assert.strictEqual(code, 1);
    });
    await test('production refuses to start without BRIDGE_SECRET', async () => {
        const code = await new Promise((resolve) => {
            const p = spawn('node', [BRIDGE], { env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '18792' }, stdio: 'ignore' });
            p.on('exit', resolve);
        });
        assert.strictEqual(code, 1);
    });

    process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
};

const cleanup = () => { children.forEach((c) => { try { c.kill('SIGKILL'); } catch (_) { /* gone */ } }); cdn.close(); };
const hard = setTimeout(() => { process.stdout.write('HARD TIMEOUT\n'); cleanup(); process.exit(2); }, 120000);
main().then(() => { clearTimeout(hard); cleanup(); process.exit(failures.length ? 1 : 0); }, (e) => { console.error(e); cleanup(); process.exit(1); });
