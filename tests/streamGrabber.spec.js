// Copyright (C) 2017-2023 Smart code 203358507

const { getGrabTarget, getGrabKey, isBridgeUrl, isDirectFileUrl, grabStreamUrl } = require('../src/routes/Player/streamGrabber');

describe('streamGrabber client', () => {
    const origin = 'https://app.example.com';
    beforeEach(() => {
        global.window = { location: { origin } };
    });
    afterEach(() => {
        delete global.fetch;
    });

    test('getGrabTarget', () => {
        expect(getGrabTarget('movie', 'tt0096895')).toEqual({ imdb: 'tt0096895', type: 'movie' });
        expect(getGrabTarget('series', 'tt0944947:1:2')).toEqual({ imdb: 'tt0944947', type: 'series', season: '1', episode: '2' });
        expect(getGrabTarget('series', 'tt0944947')).toBeNull();
        expect(getGrabTarget('movie', 'kitsu:1')).toBeNull();
        expect(getGrabTarget('channel', 'tt1')).toBeNull();
        expect(getGrabTarget('movie', undefined)).toBeNull();
        expect(getGrabKey(null)).toBeNull();
    });

    test('isBridgeUrl only accepts signed same-origin proxy urls', () => {
        const ok = `${origin}/streamgrabber/proxy?url=${encodeURIComponent('https://cdn/x.m3u8')}&exp=1&sig=abc`;
        expect(isBridgeUrl(ok)).toBe(true);
        expect(isBridgeUrl('/streamgrabber/proxy?url=x&exp=1&sig=abc')).toBe(true);
        expect(isBridgeUrl(`${origin}/streamgrabber/proxy?url=x`)).toBe(false);
        expect(isBridgeUrl('https://evil.example/streamgrabber/proxy?url=x&exp=1&sig=a')).toBe(false);
        expect(isBridgeUrl('https://cdn.example/master.m3u8')).toBe(false);
        expect(isBridgeUrl('javascript:alert(1)')).toBe(false);
    });

    test('grabStreamUrl returns the bridge url unchanged and rejects errors', async () => {
        const url = `${origin}/streamgrabber/proxy?url=x&exp=1&sig=a`;
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ stream_urls: [url] }) });
        await expect(grabStreamUrl({ imdb: 'tt1', type: 'movie' })).resolves.toBe(url);
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'no stream urls' }) });
        await expect(grabStreamUrl({ imdb: 'tt1', type: 'movie' })).rejects.toThrow('no stream urls');
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
        await expect(grabStreamUrl({ imdb: 'tt1', type: 'movie' })).rejects.toThrow('Bridge error 502');
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ stream_urls: ['https://cdn.example/x.m3u8'] }) });
        await expect(grabStreamUrl({ imdb: 'tt1', type: 'movie' })).rejects.toThrow('No stream URL');
    });

    test('isDirectFileUrl detects plain video files behind the bridge (plain and base64 url param)', () => {
        const wrap = (target, b64) => `${origin}/streamgrabber/proxy?url=${b64 ? Buffer.from(target).toString('base64url') : encodeURIComponent(target)}&exp=1&sig=abc`;
        global.atob = (value) => Buffer.from(value, 'base64').toString('binary');
        expect(isDirectFileUrl(wrap('https://cdn.example/bt/abc.mp4?sign=1&t=2', true))).toBe(true);
        expect(isDirectFileUrl(wrap('https://cdn.example/bt/abc.mp4?sign=1&t=2', false))).toBe(true);
        expect(isDirectFileUrl(wrap('https://cdn.example/a/index.m3u8?t=1', true))).toBe(false);
        expect(isDirectFileUrl(wrap('https://cdn.example/a/page-0.html', false))).toBe(false);
        expect(isDirectFileUrl('not a url')).toBe(false);
        expect(isDirectFileUrl(undefined)).toBe(false);
    });
});
