// Copyright (C) 2017-2023 Smart code 203358507

// Resolves the playable stream URL through the streamgrabber bridge
// (tools/streamgrabber-bridge.js).
//
// Paths are relative to the app origin on purpose: the bridge is exposed by
// nginx under /streamgrabber/. Native / WebView wrappers have no useful origin
// and must set STREAMGRABBER_BASE (e.g. 'https://server.example.com') below.

const STREAMGRABBER_BASE = '';
const GRAB_PATH = '/streamgrabber/grab';
const PROXY_PATH = '/streamgrabber/proxy';
const GRAB_TIMEOUT_MS = 30000;
// false: if the grab fails, show a toast and fall back to the addon stream.
// true: show a playback error instead of falling back.
const STRICT_STREAMGRABBER = true;
const GRABBER_STREAM_NAME = 'StreamGrabber';
const IMDB_REGEX = /^tt\d+$/;

const getOrigin = () => STREAMGRABBER_BASE || window.location.origin;

const getGrabTarget = (type, videoId) => {
    if (typeof videoId !== 'string' || (type !== 'movie' && type !== 'series')) return null;
    const [imdb, season, episode] = videoId.split(':');
    if (!IMDB_REGEX.test(imdb)) return null;
    if (type === 'series') {
        return season && episode ? { imdb, type, season, episode } : null;
    }
    return { imdb, type };
};

const getGrabKey = (target) => target ?
    [target.imdb, target.type, target.season, target.episode].join('|')
    :
    null;

// True only for URLs the bridge itself produced (same bridge origin, proxy path, signed).
const isBridgeUrl = (value) => {
    try {
        const url = new URL(value, getOrigin());
        return url.origin === new URL(getOrigin()).origin &&
            url.pathname === PROXY_PATH &&
            url.searchParams.has('url') &&
            url.searchParams.has('sig') &&
            url.searchParams.has('exp');
    } catch (_) {
        return false;
    }
};

// Returns the signed bridge URL for `value`, peeling unsigned /proxy wrappers around it
// (proxy?url=<signed bridge url>), or null if `value` is not (a wrapped) bridge URL.
const unwrapBridgeUrl = (value) => {
    let current = value;
    for (let i = 0; i < 4; i++) {
        if (typeof current !== 'string' || !current) return null;
        if (isBridgeUrl(current)) return new URL(current, getOrigin()).href;
        let url;
        try {
            url = new URL(current, getOrigin());
        } catch (_) {
            return null;
        }
        if (url.origin !== new URL(getOrigin()).origin || url.pathname !== PROXY_PATH) return null;
        current = url.searchParams.get('url');
    }
    return null;
};

// The bridge's `url` param is either the plain absolute upstream URL or its base64(url) encoding.
const decodeTargetParam = (raw) => {
    if (typeof raw !== 'string' || !raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    try {
        const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
        return /^https?:\/\//i.test(decoded) ? decoded : null;
    } catch (_) {
        return null;
    }
};

// True when the upstream behind a bridge URL is a plain video file (.mp4, .webm, ...), which must be
// played natively. Declaring those as HLS makes hls.js choke on them ("Video is not supported").
// Anything else (.m3u8, extension-less or disguised playlists) keeps being treated as HLS: the bridge
// sniffs those and reports the right content type itself.
const DIRECT_FILE_REGEX = /\.(mp4|m4v|mov|webm|mkv)$/i;
const isDirectFileUrl = (value) => {
    try {
        const bridgeUrl = unwrapBridgeUrl(value) ?? value;
        const target = decodeTargetParam(new URL(bridgeUrl, getOrigin()).searchParams.get('url'));
        return target !== null && DIRECT_FILE_REGEX.test(new URL(target).pathname);
    } catch (_) {
        return false;
    }
};

const grabStreamUrl = async (target, signal, { fresh = false } = {}) => {
    const query = new URLSearchParams({ imdb: target.imdb, type: target.type });
    if (fresh) query.set('fresh', '1');
    if (target.season) query.set('season', target.season);
    if (target.episode) query.set('episode', target.episode);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), GRAB_TIMEOUT_MS);

    try {
        const response = await fetch(`${getOrigin()}${GRAB_PATH}?${query}`, { signal: controller.signal });
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            // non-JSON error page, handled below
        }
        if (!response.ok) throw new Error(data?.error ?? `Bridge error ${response.status}`);
        const url = data?.stream_urls?.[0];
        if (typeof url !== 'string' || !isBridgeUrl(url)) throw new Error('No stream URL returned');
        // Use the bridge URL exactly as returned (already signed and proxied).
        return new URL(url, getOrigin()).href;
    } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) throw new Error('Stream lookup timed out');
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
};

module.exports = {
    GRABBER_STREAM_NAME,
    STRICT_STREAMGRABBER,
    getGrabTarget,
    getGrabKey,
    isBridgeUrl,
    unwrapBridgeUrl,
    isDirectFileUrl,
    grabStreamUrl
};
