// useRemotePlayback.js
//
// Aggregates every remote-play method the current video element supports into a
// single ordered list. The UI (ControlBar) renders one button from that list:
//   - 0 methods -> help sheet
//   - 1 method  -> click starts it directly
//   - 2+ methods -> click opens the CastDevicesMenu dropdown
//
// Availability is re-evaluated whenever the underlying service/video state
// changes (chromecast 'stateChanged', webkitplaybacktargetavailabilitychanged,
// remote.watchAvailability callbacks, or the video element being replaced).
const React = require('react');
const { useServices } = require('stremio/services');

const isIOS = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent);

// Pure method-list builder. Extracted so it can be unit tested without rendering.
function buildMethods({
    chromecast,
    shellActive,
    shellCastSupported,
    airplayAvailable,
    remoteAvailable,
    videoElement,
}) {
    const list = [];
    const chromecastActive = !!(chromecast && chromecast.active);

    // Chromecast web SDK: never runs on iOS, so it cannot be offered there.
    if (chromecastActive && !isIOS()) {
        list.push({
            id: 'chromecast',
            label: 'Chromecast',
            available: true,
            start: () => {
                try {
                    if (chromecast && chromecast.transport && typeof chromecast.transport.requestSession === 'function') {
                        chromecast.transport.requestSession();
                    }
                } catch (_e) {
                    void _e;
                }
            }
        });
    }

    // Shell (desktop) cast devices.
    if (shellActive && shellCastSupported) {
        list.push({
            id: 'shell',
            label: 'Cast devices',
            available: true,
            start: () => {
                // shell start is handled via the menu/open mechanism in UI
            }
        });
    }

    // AirPlay: when WebKit API exists (be permissive on iOS Safari)
    const webkitExists = typeof window !== 'undefined' && !!window.WebKitPlaybackTargetAvailabilityEvent;
    const ios = isIOS();
    if (webkitExists && videoElement && (airplayAvailable || ios)) {
        list.push({
            id: 'airplay',
            label: 'AirPlay',
            available: true,
            start: () => {
                try {
                    if (typeof videoElement.webkitShowPlaybackTargetPicker === 'function') {
                        videoElement.webkitShowPlaybackTargetPicker();
                    }
                } catch (_e) {
                    void _e;
                }
            }
        });
    }

    // Generic Remote Playback API: only as a fallback when neither
    // Chromecast nor AirPlay is already covering the path.
    const hasChromecastOrAirplay = list.some((m) => m.id === 'chromecast' || m.id === 'airplay');
    if (videoElement && videoElement.remote && remoteAvailable && !hasChromecastOrAirplay) {
        list.push({
            id: 'remote',
            label: 'Remote playback',
            available: true,
            start: () => {
                try {
                    videoElement.remote.prompt();
                } catch (_e) {
                    void _e;
                }
            }
        });
    }

    return list;
}

const useRemotePlayback = (videoElement, shellCastSupported = false) => {
    const services = useServices();
    const chromecast = services && services.chromecast;
    const platform = typeof window !== 'undefined' && window.__platform ? window.__platform : null;
    const shellActive = !!(platform && platform.shell && platform.shell.active);

    const [methods, setMethods] = React.useState([]);
    const [airplayAvailable, setAirplayAvailable] = React.useState(false);
    const [airplayWireless, setAirplayWireless] = React.useState(false);
    const [remoteAvailable, setRemoteAvailable] = React.useState(false);

    // --- AirPlay (Safari/WebKit only) ---------------------------------------
    // Listens to the video element's webkit playback-target events so the
    // availability flips whenever a nearby target appears/disappears.
    React.useEffect(() => {
        if (!videoElement) return;
        const onAvail = (e) => {
            if (e && typeof e.availability !== 'undefined') {
                setAirplayAvailable(e.availability === 'available');
            } else {
                setAirplayAvailable(false);
            }
        };
        const onWireless = () => {
            try {
                setAirplayWireless(!!videoElement.webkitCurrentPlaybackTargetIsWireless);
            } catch (_e) {
                void _e;
            }
        };
        try {
            videoElement.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
            videoElement.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
        } catch (_e) {
            void _e;
        }
        return () => {
            try {
                videoElement.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
                videoElement.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWireless);
            } catch (_e) {
                void _e;
            }
        };
    }, [videoElement]);

    // --- Generic Remote Playback API ----------------------------------------
    // Only used when neither Chromecast nor AirPlay is the active path.
    React.useEffect(() => {
        if (!videoElement) return;
        const remote = videoElement.remote;
        if (!remote) return;
        // watchAvailability() resolves with a numeric callback id, and that id (not the callback
        // function) is what cancelWatchAvailability() needs. Passing the function made it reject
        // with NotFoundError on every cleanup, as an unhandled promise rejection.
        let disposed = false;
        let watchId = null;
        const cancelWatch = (id) => {
            try {
                const result = remote.cancelWatchAvailability(id);
                if (result && typeof result.catch === 'function') {
                    result.catch((_e) => {
                        void _e;
                    });
                }
            } catch (_e) {
                void _e;
            }
        };
        const cb = (available) => {
            if (!disposed) setRemoteAvailable(!!available);
        };
        try {
            if (typeof remote.watchAvailability === 'function') {
                const pending = remote.watchAvailability(cb);
                if (pending && typeof pending.then === 'function') {
                    pending.then((id) => {
                        if (disposed) {
                            cancelWatch(id);
                        } else {
                            watchId = id;
                        }
                    }).catch(() => {
                        // NotSupportedError (disableRemotePlayback, no backend, ...)
                        if (!disposed) setRemoteAvailable(false);
                    });
                }
            } else {
                setRemoteAvailable(false);
            }
        } catch (_e) {
            setRemoteAvailable(false);
        }
        return () => {
            disposed = true;
            if (watchId !== null && typeof remote.cancelWatchAvailability === 'function') {
                cancelWatch(watchId);
            }
        };
    }, [videoElement]);

    // --- Build the method list ----------------------------------------------
    // Rebuilt whenever any of the inputs that affect availability changes.
    const lastMethodsRef = React.useRef([]);
    const ios = isIOS();
    React.useEffect(() => {
        const next = buildMethods({
            chromecast,
            shellActive,
            shellCastSupported,
            airplayAvailable: ios ? true : airplayAvailable,
            remoteAvailable,
            videoElement,
        });
        // Avoid constant re-renders if nothing changed
        const same = next.length === lastMethodsRef.current.length && next.every((m, i) => {
            const lm = lastMethodsRef.current[i];
            return lm && lm.id === m.id && lm.label === m.label;
        });
        if (!same) {
            lastMethodsRef.current = next;
            setMethods(next);
        }

        if (chromecast && typeof chromecast.on === 'function') {
            const onStateChanged = () => {
                const next2 = buildMethods({
                    chromecast,
                    shellActive,
                    shellCastSupported,
                    airplayAvailable: ios ? true : airplayAvailable,
                    remoteAvailable,
                    videoElement,
                });
                const same2 = next2.length === lastMethodsRef.current.length && next2.every((m, i) => {
                    const lm = lastMethodsRef.current[i];
                    return lm && lm.id === m.id && lm.label === m.label;
                });
                if (!same2) {
                    lastMethodsRef.current = next2;
                    setMethods(next2);
                }
            };
            chromecast.on('stateChanged', onStateChanged);
            return () => {
                try {
                    chromecast.off('stateChanged', onStateChanged);
                } catch (_e) {
                    void _e;
                }
            };
        }
        return undefined;
    }, [chromecast, shellActive, shellCastSupported, ios ? null : airplayAvailable, remoteAvailable, videoElement]);

    return { methods, anyAvailable: methods.length > 0, airplayWireless };
};

module.exports = useRemotePlayback;
module.exports.default = useRemotePlayback;
module.exports.buildMethods = buildMethods;
module.exports.isIOS = isIOS;
