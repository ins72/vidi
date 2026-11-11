// useRemotePlayback.spec.js
// Unit tests for the remote-play method aggregation logic.
//
// The pure `buildMethods` helper is exported from useRemotePlayback.js so it can
// be tested without rendering React or a real DOM (this environment has no jsdom).

const useRemotePlayback = require('../src/routes/Player/useRemotePlayback');
const { buildMethods, isIOS } = useRemotePlayback;

jest.mock('stremio/services', () => ({
    useServices: jest.fn(),
}));

global.window = global.window || {};
global.navigator = global.navigator || { userAgent: '' };

const origNavigator = global.navigator;
const origUserAgent = origNavigator && origNavigator.userAgent;
const origWebkit = global.window && global.window.WebKitPlaybackTargetAvailabilityEvent;

function makeChromecast({ active = true } = {}) {
    return {
        active,
        on: jest.fn(),
        off: jest.fn(),
        transport: {
            requestSession: jest.fn(),
            endCurrentSession: jest.fn(),
        },
    };
}

function makeVideo(overrides = {}) {
    const remote = {
        watchAvailability: jest.fn(),
        cancelWatchAvailability: jest.fn(),
        prompt: jest.fn(),
    };
    return {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        webkitShowPlaybackTargetPicker: jest.fn(),
        webkitCurrentPlaybackTargetIsWireless: false,
        remote,
        ...overrides,
    };
}

function setUserAgent(ua) {
    global.navigator = { userAgent: ua };
}
function restoreNavigator() {
    global.navigator = origNavigator;
}
function setWebkitEvent(present) {
    if (present) {
        global.window.WebKitPlaybackTargetAvailabilityEvent = function WebKitPlaybackTargetAvailabilityEvent() {};
    } else {
        delete global.window.WebKitPlaybackTargetAvailabilityEvent;
    }
}
function restoreWebkit() {
    if (origWebkit === undefined) {
        delete global.window.WebKitPlaybackTargetAvailabilityEvent;
    } else {
        global.window.WebKitPlaybackTargetAvailabilityEvent = origWebkit;
    }
}

beforeEach(() => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Desktop');
    setWebkitEvent(true);
});

afterEach(() => {
    restoreNavigator();
    restoreWebkit();
});

describe('buildMethods', () => {
    test('returns an empty list with no video element and no services', () => {
        expect(buildMethods({})).toEqual([]);
    });

    test('exposes chromecast when active and not iOS', () => {
        const chromecast = makeChromecast({ active: true });
        const methods = buildMethods({ chromecast, videoElement: makeVideo() });
        expect(methods.find((m) => m.id === 'chromecast')).toBeDefined();
    });

    test('excludes chromecast on iOS even when active', () => {
        setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
        const chromecast = makeChromecast({ active: true });
        const methods = buildMethods({ chromecast, videoElement: makeVideo() });
        expect(methods.find((m) => m.id === 'chromecast')).toBeUndefined();
        expect(isIOS()).toBe(true);
    });

    test('excludes chromecast when inactive', () => {
        const chromecast = makeChromecast({ active: false });
        const methods = buildMethods({ chromecast });
        expect(methods.find((m) => m.id === 'chromecast')).toBeUndefined();
    });

    test('exposes shell when shell active and supported', () => {
        const methods = buildMethods({ shellActive: true, shellCastSupported: true });
        expect(methods.find((m) => m.id === 'shell')).toBeDefined();
    });

    test('excludes shell when not supported', () => {
        const methods = buildMethods({ shellActive: true, shellCastSupported: false });
        expect(methods.find((m) => m.id === 'shell')).toBeUndefined();
    });

    test('excludes shell when shell inactive', () => {
        const methods = buildMethods({ shellActive: false, shellCastSupported: true });
        expect(methods.find((m) => m.id === 'shell')).toBeUndefined();
    });

    test('exposes airplay when webkit API present and availability available', () => {
        const video = makeVideo();
        const methods = buildMethods({ airplayAvailable: true, videoElement: video });
        const airplay = methods.find((m) => m.id === 'airplay');
        expect(airplay).toBeDefined();
        expect(typeof airplay.start).toBe('function');
        airplay.start();
        expect(video.webkitShowPlaybackTargetPicker).toHaveBeenCalled();
    });

    test('excludes airplay when webkit API missing', () => {
        setWebkitEvent(false);
        const video = makeVideo();
        const methods = buildMethods({ airplayAvailable: true, videoElement: video });
        expect(methods.find((m) => m.id === 'airplay')).toBeUndefined();
    });

    test('excludes airplay when availability not available', () => {
        const video = makeVideo();
        const methods = buildMethods({ airplayAvailable: false, videoElement: video });
        expect(methods.find((m) => m.id === 'airplay')).toBeUndefined();
    });

    test('exposes remote fallback when no chromecast/airplay and remote available', () => {
        const video = makeVideo();
        setWebkitEvent(false);
        const methods = buildMethods({ remoteAvailable: true, videoElement: video });
        const remote = methods.find((m) => m.id === 'remote');
        expect(remote).toBeDefined();
        expect(typeof remote.start).toBe('function');
        remote.start();
        expect(video.remote.prompt).toHaveBeenCalled();
    });

    test('excludes remote when chromecast already covers the path', () => {
        const video = makeVideo();
        const chromecast = makeChromecast({ active: true });
        const methods = buildMethods({ chromecast, remoteAvailable: true, videoElement: video });
        expect(methods.find((m) => m.id === 'remote')).toBeUndefined();
    });

    test('excludes remote when airplay already covers the path', () => {
        const video = makeVideo();
        const methods = buildMethods({ airplayAvailable: true, remoteAvailable: true, videoElement: video });
        expect(methods.find((m) => m.id === 'remote')).toBeUndefined();
    });

    test('lists chromecast and remote together when both eligible', () => {
        const video = makeVideo();
        setWebkitEvent(false);
        const chromecast = makeChromecast({ active: true });
        const methods = buildMethods({ chromecast, remoteAvailable: true, videoElement: video });
        const ids = methods.map((m) => m.id);
        expect(ids).toContain('chromecast');
        expect(ids).not.toContain('remote'); // remote suppressed by chromecast
    });

    test('single method start invokes the underlying start', () => {
        const video = makeVideo();
        setWebkitEvent(false);
        const methods = buildMethods({ remoteAvailable: true, videoElement: video });
        expect(methods.length).toBe(1);
        expect(typeof methods[0].start).toBe('function');
        methods[0].start();
        expect(video.remote.prompt).toHaveBeenCalled();
    });

    test('null videoElement yields no airplay/remote methods', () => {
        const methods = buildMethods({ airplayAvailable: true, remoteAvailable: true });
        expect(methods).toEqual([]);
    });

    test('isIOS detection', () => {
        setUserAgent('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)');
        expect(isIOS()).toBe(true);
        setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        expect(isIOS()).toBe(false);
    });
});
