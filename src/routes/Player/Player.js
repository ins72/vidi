// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { useParams, useNavigate } = require('react-router');
const { useSearchParams } = require('react-router-dom');
const classnames = require('classnames');
const debounce = require('lodash.debounce');
const { useTranslation } = require('react-i18next');
const { default: useRouteFocused } = require('stremio/common/useRouteFocused');
const { useCore } = require('stremio/core');
const { useServices, useGamepad } = require('stremio/services');
const { useContentGamepadNavigation } = require('stremio/services/GamepadNavigation');
const { useSettings, useProfile, useFullscreen, useBinaryState, useToast, useStreamingServer, withCoreSuspender, usePlatform, useShortcut, getKeyboardShortcutKey, getKeyboardShortcutKeys, useDiscord, EMPTY_DISCORD_TIMESTAMPS, getPlaybackDiscordActivity } = require('stremio/common');
const { EPG_PLAYER_NOW_REFRESH_INTERVAL, getEpgTimeRange, useLiveRefresh } = require('stremio/common/EPG');
const { default: toPath } = require('stremio-router/toPath');
const { useGoBack } = require('stremio-router');
const { HorizontalNavBar, Transition, ContextMenu } = require('stremio/components');
const { default: Buffering } = require('./Buffering');
const VolumeChangeIndicator = require('./VolumeChangeIndicator');
const Error = require('./Error');
const ControlBar = require('./ControlBar');
const NextVideoPopup = require('./NextVideoPopup');
const StatisticsMenu = require('./StatisticsMenu');
const OptionsMenu = require('./OptionsMenu');
const { default: CastDevicesMenu } = require('./CastDevicesMenu');
const SubtitlesMenu = require('./SubtitlesMenu');
const { default: AudioMenu } = require('./AudioMenu');
const SpeedMenu = require('./SpeedMenu');
const { default: SideDrawerButton } = require('./SideDrawerButton');
const { default: SideDrawer } = require('./SideDrawer');
const usePlayer = require('./usePlayer');
const { default: usePlayOnDevice } = require('./usePlayOnDevice');
const { default: useCastDevice } = require('./useCastDevice');
const { default: useKeyboardSeek } = require('./useKeyboardSeek');
const { default: usePlaybackSpeedHold } = require('./usePlaybackSpeedHold');
const { default: useStatistics } = require('./useStatistics');
const useVideo = require('./useVideo');
const useRemotePlayback = require('./useRemotePlayback');
const { default: useAudio } = require('./useAudio');
const { default: useSubtitles } = require('./useSubtitles');
const styles = require('./styles');
const Video = require('./Video');
const { default: Indicator } = require('./Indicator/Indicator');
const { default: useMediaSession } = require('./useMediaSession');
// The bridge always serves HLS. Declaring the type up front makes the player skip its HEAD probe,
// which would otherwise decide HLS vs. plain video from the upstream's (often wrong) Content-Type.
const HLS_BEHAVIOR_HINTS = { proxyHeaders: { request: {}, response: { 'content-type': 'application/vnd.apple.mpegurl' } } };
const { GRABBER_STREAM_NAME, STRICT_STREAMGRABBER, getGrabTarget, getGrabKey, unwrapBridgeUrl, isDirectFileUrl, grabStreamUrl } = require('./streamGrabber');
// Plain files behind the bridge (.mp4, ...) are played natively; only playlists get the HLS hints.
const bridgeStreamProps = (url) => isDirectFileUrl(url) ? {} : { type: 'hls', behaviorHints: HLS_BEHAVIOR_HINTS };

// DEBUG PANEL (temporary, shown only if ?debug=1)
const DEBUG_ENABLED = typeof window !== 'undefined' && (new URLSearchParams(window.location.search)).get('debug') === '1';

if (typeof window !== 'undefined') {
    if (!window.__PLAYER_DEBUG_LOGS) window.__PLAYER_DEBUG_LOGS = [];
    window.__PLAYER_DEBUG_PUSH = function(msg) {
        try {
            var entry = '[' + new Date().toISOString() + '] ' + msg;
            window.__PLAYER_DEBUG_LOGS.push(entry);
            if (window.__PLAYER_DEBUG_LOGS.length > 5000) {
                window.__PLAYER_DEBUG_LOGS.shift();
            }
            if (window.__PLAYER_DEBUG_UPDATE) window.__PLAYER_DEBUG_UPDATE();
        } catch(e) {}
    };
}

const GAMEPAD_HANDLER_ID = 'player';

const CAST_DEVICES_REFRESH_INTERVAL = 5000;

const Player = () => {
    const { stream, streamTransportUrl, metaTransportUrl, type, id, videoId } = useParams();
    const urlParams = React.useMemo(() => ({
        stream,
        streamTransportUrl,
        metaTransportUrl,
        type,
        id,
        videoId
    }), [stream, streamTransportUrl, metaTransportUrl, type, id, videoId]);
    const [queryParams] = useSearchParams();
    const navigate = useNavigate();
    const goBack = useGoBack();
    const { t } = useTranslation();
    const services = useServices();
    const core = useCore();
    const gamepad = useGamepad();
    const forceTranscoding = React.useMemo(() => {
        return queryParams.has('forceTranscoding');
    }, [queryParams]);
    const profile = useProfile();
    const [player, videoParamsChanged, streamStateChanged, audioPreferenceChanged, subtitlePreferenceChanged, videoScaleChanged, timeChanged, seek, pausedChanged, ended, nextVideo] = usePlayer(urlParams);
    const [settings] = useSettings();
    const streamingServer = useStreamingServer();
    const statistics = useStatistics(player, streamingServer);
    const video = useVideo();
    const [videoElement, setVideoElementState] = React.useState(null);

    // `video` is a fresh object on every render, so depend only on its stable members.
    // Depending on `video` itself (and nulling the element in the cleanup) made this effect
    // re-run on every render and produced an endless null -> element -> null render loop.
    const getHtmlVideoElement = video.getVideoElement;
    const videoContainerRef = video.containerRef;
    React.useEffect(() => {
        const findEl = () => {
            try {
                if (typeof getHtmlVideoElement === 'function') {
                    const vel = getHtmlVideoElement();
                    if (vel) return vel;
                }
            } catch (_e) {
                void _e;
            }
            try {
                if (videoContainerRef && videoContainerRef.current) {
                    const el = videoContainerRef.current.querySelector('video');
                    if (el) return el;
                }
            } catch (_e) {
                void _e;
            }
            return null;
        };
        // Functional update: no stale closure over `videoElement`, and no re-render when unchanged.
        const sync = () => {
            const el = findEl();
            if (el) {
                setVideoElementState((prev) => prev === el ? prev : el);
            }
        };
        sync();
        let observer = null;
        try {
            const container = videoContainerRef && videoContainerRef.current;
            if (container && typeof MutationObserver !== 'undefined') {
                observer = new MutationObserver(sync);
                observer.observe(container, { childList: true, subtree: true });
            }
        } catch (_e) {
            void _e;
        }
        const id = setInterval(sync, 500);
        return () => {
            clearInterval(id);
            if (observer) {
                try {
                    observer.disconnect();
                } catch (_e) {
                    void _e;
                }
            }
        };
    }, [getHtmlVideoElement, videoContainerRef, video.state.manifest]);
    const remotePlayback = useRemotePlayback(videoElement, shellCastSupported);
    const remoteMethods = remotePlayback.methods;
    // `chromecastCasting` is the Chromecast-only state; the combined `casting`
    // flag (used by the ControlBar) is computed below, after `isCasting` is
    // defined, so it covers Chromecast, AirPlay and desktop-shell casting.
    const [chromecastCasting, setCasting] = React.useState(() => {
        return services.chromecast.active && services.chromecast.transport.getCastState() === cast.framework.CastState.CONNECTED;
    });
    const routeFocused = useRouteFocused();
    const platform = usePlatform();
    const toast = useToast();
    const discord = useDiscord();
    const discordTimestamps = React.useRef(EMPTY_DISCORD_TIMESTAMPS);

    // streamgrabber: resolve the IMDb id to a bridge URL. Only the stream URL is
    // swapped later on, so metadata, progress and next-episode info stay upstream's.
    const sgTarget = React.useMemo(() => getGrabTarget(type, videoId), [type, videoId]);
    const sgKey = getGrabKey(sgTarget);
    const [sgResult, setSgResult] = React.useState({ key: null, url: null });
    const [sgAttempt, setSgAttempt] = React.useState(0);
    const sgStatus = sgKey === null ? 'none' : sgResult.key !== sgKey ? 'pending' : sgResult.url ? 'ready' : 'failed';
    const sgUrl = sgStatus === 'ready' ? sgResult.url : null;
    // A signed URL can outlive its upstream token (paused tab, slow resume). On the first critical playback
    // error per title, ask the bridge for a fresh lookup (bypassing its cache) instead of showing the error.
    const sgRetriedRef = React.useRef(null);
    const sgRetryRef = React.useRef(() => false);
    sgRetryRef.current = () => {
        if (sgStatus !== 'ready' || sgRetriedRef.current === sgKey) return false;
        sgRetriedRef.current = sgKey;
        setSgResult({ key: null, url: null });
        setSgAttempt((n) => n + 1);
        return true;
    };

    React.useEffect(() => {
        if (sgTarget === null) return;
        const controller = new AbortController();
        grabStreamUrl(sgTarget, controller.signal, { fresh: sgAttempt > 0 })
            .then((url) => setSgResult({ key: getGrabKey(sgTarget), url }))
            .catch((err) => {
                if (controller.signal.aborted) return;
                console.error('Streamgrabber resolution failed:', err);
                setSgResult({ key: getGrabKey(sgTarget), url: null });
                if (!STRICT_STREAMGRABBER) {
                    toast.show({
                        type: 'error',
                        title: t('ERROR'),
                        message: err.message,
                        timeout: 5000
                    });
                }
            });
        return () => controller.abort();
    }, [sgKey, sgAttempt]);

    // Direct stream via ?streamUrl= - accepted only if it is a signed URL produced by the bridge.
    const directStream = React.useMemo(() => {
        const streamUrl = queryParams.get('streamUrl');
        const bridgeUrl = unwrapBridgeUrl(streamUrl);
        if (!bridgeUrl) return null;
        return {
            url: bridgeUrl,
            ...bridgeStreamProps(bridgeUrl),
            name: GRABBER_STREAM_NAME,
            description: 'Stream provided via streamgrabber URL'
        };
    }, [queryParams]);

    const [seeking, setSeeking] = React.useState(false);

    const playbackDevices = React.useMemo(() => streamingServer.playbackDevices !== null && streamingServer.playbackDevices.type === 'Ready' ? streamingServer.playbackDevices.content : [], [streamingServer]);

    const containerRef = React.useRef(null);
    const bufferingRef = React.useRef();
    const errorRef = React.useRef();

    const [immersed, setImmersed] = React.useState(true);
    const setImmersedDebounced = React.useCallback(debounce(setImmersed, 3000), []);
    const [fullscreen, , , toggleFullscreen, , setVideoElement] = useFullscreen();

    React.useEffect(() => {
        const el = containerRef.current?.querySelector('video');
        setVideoElement(el || null);
        return () => setVideoElement(null);
    }, [video.state.manifest]);

    const [optionsMenuOpen, , closeOptionsMenu, toggleOptionsMenu] = useBinaryState(false);
    const [subtitlesMenuOpen, , closeSubtitlesMenu, toggleSubtitlesMenu] = useBinaryState(false);
    const [audioMenuOpen, , closeAudioMenu, toggleAudioMenu] = useBinaryState(false);
    const [speedMenuOpen, , closeSpeedMenu, toggleSpeedMenu] = useBinaryState(false);
    const [statisticsMenuOpen, openStatisticsMenu, closeStatisticsMenu, toggleStatisticsMenu] = useBinaryState(false);
    const [castDevicesMenuOpen, , closeCastDevicesMenu, toggleCastDevicesMenu] = useBinaryState(false);
    const metaItemContent = player.metaItem !== null && player.metaItem.type === 'Ready' ? player.metaItem.content : null;

    const isEpg = (player.live ?? null) !== null;
    const currentEpgVideo = player.live?.currentProgram ?? null;
    const upcomingVideo = isEpg ? player.live?.nextProgram ?? null : player.nextVideo;
    const epgNow = useLiveRefresh('Player', 'player', isEpg, EPG_PLAYER_NOW_REFRESH_INTERVAL);
    const livePlayback = isEpg || video.state.live !== null;
    const seekStart = livePlayback ? video.state.live?.start : 0;
    const seekEnd = livePlayback ? video.state.live?.end : video.state.duration;
    const canSeek = Number.isFinite(seekStart) && Number.isFinite(seekEnd) && seekEnd > seekStart && Number.isFinite(video.state.time);
    const [nextVideoPopupDismissal, setNextVideoPopupDismissal] = React.useState(null);
    const liveEpgRange = currentEpgVideo === null ? null : getEpgTimeRange(currentEpgVideo);
    const nextVideoRemainingTime = isEpg ?
        liveEpgRange === null ? null : liveEpgRange.endTime - epgNow
        :
        video.state.time === null || video.state.duration === null ? null : video.state.duration - video.state.time;
    const nextVideoPopupOpen = upcomingVideo !== null &&
        (nextVideoPopupDismissal === null || nextVideoPopupDismissal.stream !== video.state.stream ||
            (isEpg && nextVideoPopupDismissal.programId !== currentEpgVideo?.id)) &&
        nextVideoRemainingTime !== null && nextVideoRemainingTime > 0 &&
        nextVideoRemainingTime <= settings.nextVideoNotificationDuration;
    const [sideDrawerOpen, , closeSideDrawer, toggleSideDrawer] = useBinaryState(false);

    const menusOpen = React.useMemo(() => {
        return optionsMenuOpen || subtitlesMenuOpen || audioMenuOpen || speedMenuOpen || statisticsMenuOpen || castDevicesMenuOpen || sideDrawerOpen || nextVideoPopupOpen;
    }, [optionsMenuOpen, subtitlesMenuOpen, audioMenuOpen, speedMenuOpen, statisticsMenuOpen, castDevicesMenuOpen, sideDrawerOpen, nextVideoPopupOpen]);

    const closeMenus = React.useCallback(() => {
        closeOptionsMenu();
        closeSubtitlesMenu();
        closeAudioMenu();
        closeSpeedMenu();
        closeStatisticsMenu();
        closeCastDevicesMenu();
        closeSideDrawer();
    }, []);

    const castDevices = React.useMemo(() => {
        const all = Array.isArray(playbackDevices) ? playbackDevices : [];
        const filtered = all.filter(({ type }) => type === 'chromecast' || type === 'tv' || type === 'external' || type === 'airplay' || type === 'AirPlay');
        const result = filtered.length > 0 ? filtered : all.filter((d) => d && d.name);
        return result.sort((a, b) => {
            const ta = (a.type || '').toString().toLowerCase();
            const tb = (b.type || '').toString().toLowerCase();
            if (ta === tb) return 0;
            if (ta === 'chromecast') return -1;
            if (tb === 'chromecast') return 1;
            if (ta === 'airplay') return -1;
            if (tb === 'airplay') return 1;
            return 0;
        });
    }, [playbackDevices]);
    const [castDevicesSearching, setCastDevicesSearching] = React.useState(false);
    const castDevicesLoading = (remoteMethods && remoteMethods.length > 0) ? false : (castDevicesSearching || (streamingServer.playbackDevices !== null && streamingServer.playbackDevices.type === 'Loading'));
    const { streamingUrl: castStreamingUrl } = usePlayOnDevice(player.selected?.stream ?? null);
    const shellCastSupported = true;
    const refreshCastDevices = React.useCallback(() => {
        core.transport.dispatch({
            action: 'StreamingServer',
            args: {
                action: 'RefreshPlaybackDevices',
            }
        });
    }, []);
    React.useEffect(() => {
        if (castDevicesMenuOpen) {
            setCastDevicesSearching(true);
            refreshCastDevices();
            const interval = setInterval(refreshCastDevices, CAST_DEVICES_REFRESH_INTERVAL);
            const timeout = setTimeout(() => setCastDevicesSearching(false), CAST_DEVICES_REFRESH_INTERVAL);
            return () => {
                clearInterval(interval);
                clearTimeout(timeout);
                setCastDevicesSearching(false);
            };
        }
    }, [castDevicesMenuOpen, refreshCastDevices]);

    const onAudioTrackSelected = useAudio({
        player,
        video,
        settings,
        streamStateChanged,
        audioPreferenceChanged,
    });

    const {
        streamSubtitles,
        allSubtitleTracks,
        extraSubtitleTracks,
        selectedExtraSubtitleTrackId,
        subtitlesMenuProps,
    } = useSubtitles({
        player,
        video,
        settings,
        streamStateChanged,
        subtitlePreferenceChanged,
        menusOpen,
        closeMenus,
        closeSubtitlesMenu,
        toggleSubtitlesMenu,
    });

    const playingOnExternalDevice = React.useRef(false);
    const { castToDevice, stopBeforeLocalPlay, isCasting } = useCastDevice(castStreamingUrl, streamingServer.casting, video, playingOnExternalDevice);
    // Combined casting flag for the ControlBar: Chromecast (chromecastCasting),
    // AirPlay (remotePlayback.airplayWireless) or desktop-shell casting (isCasting).
    const casting = chromecastCasting || remotePlayback.airplayWireless || isCasting();
    const onCastDeviceSelected = (deviceId) => {
        castToDevice(deviceId);
        closeCastDevicesMenu();
    };
    const requestedVideoScale = React.useRef(null);
    const persistedVideoScale = React.useRef({ stream: null, scale: null });
    const [error, setError] = React.useState(null);

    const VIDEO_SCALES = ['contain', 'cover', 'fill'];
    const VIDEO_SCALE_LABELS = { contain: t('PLAYER_SCALE_FIT'), cover: t('PLAYER_SCALE_CROP'), fill: t('PLAYER_SCALE_STRETCH') };

    const {
        start: startPlaybackSpeedHold,
        finish: finishPlaybackSpeedHold,
        cancel: cancelPlaybackSpeedHold,
        isActive: isPlaybackSpeedHoldActive,
        consumeClick: consumePlaybackSpeedHoldClick,
    } = usePlaybackSpeedHold(routeFocused && !menusOpen, video.state.stream, video.state.playbackSpeed, video.setPlaybackSpeed);
    const detailsHold = React.useRef(null);
    const controlBarRef = React.useRef(null);

    const HOLD_DELAY = 400;

    const handleNextVideoNavigation = React.useCallback((deepLinks, bingeWatching, ended) => {
        if (ended) {
            if (bingeWatching) {
                if (deepLinks.player) {
                    navigate(toPath(deepLinks.player), { replace: true });
                } else if (deepLinks.metaDetailsStreams) {
                    navigate(toPath(deepLinks.metaDetailsStreams), { replace: true });
                }
            } else {
                goBack();
            }

        } else {
            if (deepLinks.player) {
                navigate(toPath(deepLinks.player), { replace: true });
            } else if (deepLinks.metaDetailsStreams) {
                navigate(toPath(deepLinks.metaDetailsStreams), { replace: true });
            }
        }
    }, [navigate, goBack]);

    const onEnded = React.useCallback(() => {
        ended();

        if (isEpg) {
            return;
        }

        if (player.nextVideo !== null) {
            nextVideo();

            const deepLinks = player.nextVideo.deepLinks;
            handleNextVideoNavigation(deepLinks, profile.settings.bingeWatching, true);
        } else {
            goBack();
        }
    }, [isEpg, player.nextVideo, profile.settings.bingeWatching, handleNextVideoNavigation, ended, nextVideo, goBack]);

    const onError = React.useCallback((error) => {
        console.error('Player', error);
        if (error.critical && sgRetryRef.current()) return;
        if (error.critical) {
            setError(error);
        } else {
            toast.show({
                type: 'error',
                title: t('ERROR'),
                message: error.message,
                timeout: 3000
            });
        }
    }, []);

    const onPlayRequested = React.useCallback(() => {
        setSeeking(false);
        if (stopBeforeLocalPlay()) return;
        playingOnExternalDevice.current = false;
        video.setPaused(false);
    }, []);

    const onPlayRequestedDebounced = React.useCallback(debounce(onPlayRequested, 200), []);

    const onPauseRequested = React.useCallback(() => {
        video.setPaused(true);
    }, []);

    const onPauseRequestedDebounced = React.useCallback(debounce(onPauseRequested, 200), []);
    const onMuteRequested = React.useCallback(() => {
        video.setMuted(true);
    }, []);

    const onUnmuteRequested = React.useCallback(() => {
        video.setMuted(false);
    }, []);

    const onVolumeChangeRequested = React.useCallback((volume) => {
        video.setVolume(volume);
    }, []);

    const commitSeek = React.useCallback((time) => {
        if (!canSeek) {
            return;
        }
        const target = Math.max(seekStart, Math.min(seekEnd, time));
        video.setTime(target);
        seek(target, video.state.duration, video.state.manifest?.name);
    }, [canSeek, seekStart, seekEnd, video.state.duration, video.state.manifest]);
    const {
        time: keyboardSeekTime,
        seekBy: seekByKeyboard,
        seekTo: onSeekRequested,
        cancel: cancelKeyboardSeek,
        flush: flushKeyboardSeek,
        release: releaseKeyboardSeek,
    } = useKeyboardSeek({
        time: video.state.time,
        duration: seekEnd,
        minimum: seekStart,
        onSeek: commitSeek,
        setSeeking,
    });
    const onKeyboardSeekRequested = React.useCallback((offset) => {
        if (!canSeek) {
            return;
        }
        setImmersedDebounced.cancel();
        setImmersed(false);
        seekByKeyboard(offset);
    }, [canSeek, seekByKeyboard]);
    const overlayHidden = React.useMemo(() => {
        return keyboardSeekTime === null && immersed && !casting && video.state.paused !== null && !video.state.paused && !menusOpen;
    }, [keyboardSeekTime, immersed, casting, video.state.paused, menusOpen]);

    React.useEffect(() => {
        if (!video.state.manifest?.props.includes('subtitlesOffsetMinimum')) {
            return;
        }

        const videoContainerElement = video.containerRef.current;
        const controlBarElement = controlBarRef.current;
        if (!videoContainerElement || !controlBarElement) {
            return;
        }

        const updateSubtitlesOffsetMinimum = () => {
            const videoHeight = videoContainerElement.getBoundingClientRect().height;
            const controlBarHeight = overlayHidden ? 0 : controlBarElement.getBoundingClientRect().height;
            const offsetMinimum = videoHeight > 0 ? Math.ceil(controlBarHeight / videoHeight * 100) : 0;
            video.setSubtitlesOffsetMinimum(offsetMinimum);
        };

        updateSubtitlesOffsetMinimum();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', updateSubtitlesOffsetMinimum);
            return () => window.removeEventListener('resize', updateSubtitlesOffsetMinimum);
        }

        const resizeObserver = new ResizeObserver(updateSubtitlesOffsetMinimum);
        resizeObserver.observe(videoContainerElement);
        resizeObserver.observe(controlBarElement);
        return () => resizeObserver.disconnect();
    }, [overlayHidden, video.state.manifest, video.setSubtitlesOffsetMinimum]);

    const onPlaybackSpeedChanged = video.setPlaybackSpeed;

    const onVideoScaleChanged = React.useCallback(() => {
        const currentScale = video.state.videoScale || 'contain';
        const currentIndex = VIDEO_SCALES.indexOf(currentScale);
        const nextScale = VIDEO_SCALES[(currentIndex + 1) % VIDEO_SCALES.length];
        requestedVideoScale.current = nextScale;
        persistedVideoScale.current = { stream: video.state.stream, scale: nextScale };
        video.setVideoScale(nextScale);
        if (player.videoScale !== undefined) {
            videoScaleChanged(nextScale);
        }
        streamStateChanged({ videoScale: nextScale });
    }, [player.videoScale, video.state.stream, video.state.videoScale, streamStateChanged, videoScaleChanged]);

    const onDismissNextVideoPopup = React.useCallback(() => {
        setNextVideoPopupDismissal({ stream: video.state.stream, programId: currentEpgVideo?.id });
    }, [video.state.stream, currentEpgVideo?.id]);

    const onNextVideoRequested = React.useCallback(() => {
        if (isEpg) {
            return;
        }

        if (player.nextVideo !== null) {
            cancelKeyboardSeek();
            nextVideo();

            const deepLinks = player.nextVideo.deepLinks;
            handleNextVideoNavigation(deepLinks, profile.settings.bingeWatching, false);
        }
    }, [player.nextVideo, isEpg, handleNextVideoNavigation, profile.settings, cancelKeyboardSeek, nextVideo]);

    const onVideoClick = React.useCallback(() => {
        if (video.state.paused !== null && !consumePlaybackSpeedHoldClick()) {
            if (video.state.paused) {
                onPlayRequestedDebounced();
            } else {
                onPauseRequestedDebounced();
            }
        }
    }, [video.state.paused, consumePlaybackSpeedHoldClick, onPlayRequestedDebounced, onPauseRequestedDebounced]);

    const onVideoDoubleClick = React.useCallback(() => {
        onPlayRequestedDebounced.cancel();
        onPauseRequestedDebounced.cancel();
        toggleFullscreen();
    }, [toggleFullscreen]);

    const onContainerMouseDown = React.useCallback((event) => {
        if (!event.nativeEvent.optionsMenuClosePrevented) {
            closeOptionsMenu();
        }
        if (!event.nativeEvent.subtitlesMenuClosePrevented) {
            closeSubtitlesMenu();
        }
        if (!event.nativeEvent.audioMenuClosePrevented) {
            closeAudioMenu();
        }
        if (!event.nativeEvent.speedMenuClosePrevented) {
            closeSpeedMenu();
        }
        if (!event.nativeEvent.statisticsMenuClosePrevented) {
            closeStatisticsMenu();
        }
        if (!event.nativeEvent.castDevicesMenuClosePrevented) {
            closeCastDevicesMenu();
        }

        closeSideDrawer();
    }, []);

    const onContainerMouseMove = React.useCallback((event) => {
        setImmersed(false);
        if (!event.nativeEvent.immersePrevented) {
            setImmersedDebounced(true);
        } else {
            setImmersedDebounced.cancel();
        }
    }, []);

    const onContainerMouseLeave = React.useCallback(() => {
        setImmersedDebounced.cancel();
        setImmersed(true);
    }, []);

    const onBarMouseMove = React.useCallback((event) => {
        event.nativeEvent.immersePrevented = true;
    }, []);

    const onPlayPause = React.useCallback(() => {
        if (!menusOpen && !nextVideoPopupOpen && video.state.paused !== null) {
            if (video.state.paused) {
                onPlayRequested();
                setSeeking(false);
            } else {
                onPauseRequested();
            }
        }
    }, [menusOpen, nextVideoPopupOpen, video.state.paused]);

    const onSeekPrev = React.useCallback((event) => {
        if (canSeek && !menusOpen && !nextVideoPopupOpen && video.state.time !== null) {
            const seekDuration = event?.shiftKey ? settings.seekShortTimeDuration : settings.seekTimeDuration;
            const seekTime = video.state.time - seekDuration;
            setSeeking(true);
            onSeekRequested(Math.max(seekTime, 0));
        }
    }, [canSeek, menusOpen, nextVideoPopupOpen, video.state.time]);

    const onSeekNext = React.useCallback((event) => {
        if (canSeek && !menusOpen && !nextVideoPopupOpen && video.state.time !== null) {
            const seekDuration = event?.shiftKey ? settings.seekShortTimeDuration : settings.seekTimeDuration;
            setSeeking(true);
            onSeekRequested(video.state.time + seekDuration);
        }
    }, [canSeek, menusOpen, nextVideoPopupOpen, video.state.time]);

    const onVolumeUp = React.useCallback(() => {
        if (!menusOpen && !nextVideoPopupOpen && video.state.volume !== null) {
            onVolumeChangeRequested(Math.min(video.state.volume + 5, 200));
        }
    }, [menusOpen, nextVideoPopupOpen, video.state.volume]);

    const onVolumeDown = React.useCallback(() => {
        if (!menusOpen && !nextVideoPopupOpen && video.state.volume !== null) {
            onVolumeChangeRequested(Math.max(video.state.volume - 5, 0));
        }
    }, [menusOpen, nextVideoPopupOpen, video.state.volume]);

    const onGamepadSeekAndVol = React.useCallback((axis) => {
        switch(axis) {
            case 'left': {
                onSeekPrev();
                break;
            }
            case 'right': {
                onSeekNext();
                break;
            }
            case 'up': {
                onVolumeUp();
                break;
            }
            case 'down': {
                onVolumeDown();
                break;
            }
        }
    }, [onSeekPrev, onSeekNext, onVolumeUp, onVolumeDown]);

    useContentGamepadNavigation(containerRef, GAMEPAD_HANDLER_ID);

    React.useEffect(() => {
        gamepad?.on('buttonX', GAMEPAD_HANDLER_ID, onPlayPause);
        gamepad?.on('analogRight', GAMEPAD_HANDLER_ID, onGamepadSeekAndVol);

        return () => {
            gamepad?.off('buttonX', GAMEPAD_HANDLER_ID);
            gamepad?.off('analogRight', GAMEPAD_HANDLER_ID);
        };
    }, [onPlayPause, onGamepadSeekAndVol]);

    React.useEffect(() => {
        setError(null);
        cancelKeyboardSeek();
        video.unload();

        // Direct stream URL from the bridge (?streamUrl=): no addon metadata exists for it.
        if (directStream) {
            video.load({
                stream: {
                    ...directStream,
                    subtitles: streamSubtitles
                },
                autoplay: true,
                time: 0,
                forceTranscoding: forceTranscoding || casting,
                maxAudioChannels: settings.surroundSound ? 32 : 2,
                hardwareDecoding: settings.hardwareDecoding,
                assSubtitlesStyling: settings.assSubtitlesStyling,
                gpuVideoProcessing: settings.gpuVideoProcessing && platform.shell.capabilities.gpuVideoProcessing,
                videoMode: settings.videoMode,
                platform: platform.name,
                streamingServerURL: null,
                seriesInfo: null,
            }, {
                chromecastTransport: services.chromecast.active ? services.chromecast.transport : null,
                shellTransport: platform.shell.active ? platform.shell : null,
            });
            return;
        }

        // Wait for the streamgrabber lookup briefly, but don't block playback forever.
        // If pending, proceed to addon stream fallback to avoid endless buffering
        if (sgStatus === 'pending') {
            // Don't block - fall through to addon stream
        }
        else if (sgStatus === 'failed' && STRICT_STREAMGRABBER && !sgUrl) {
            // Try to fall back to addon stream if available rather than hanging
        }

        // Streamgrabber stream: play the signed bridge URL directly (like ?streamUrl=), without the addon
        // stream or Stremio's local streaming server. Metadata, library progress, next-episode info
        // still come from the core (player.selected / metaItem / libraryItem / seriesInfo).
        if (sgUrl && player.selected) {
            video.load({
                stream: {
                    url: sgUrl,
                    ...bridgeStreamProps(sgUrl),
                    name: GRABBER_STREAM_NAME,
                    description: 'Stream provided via streamgrabber',
                    subtitles: streamSubtitles
                },
                autoplay: true,
                time: !isEpg && player.libraryItem !== null &&
                    player.selected.streamRequest !== null &&
                    player.selected.streamRequest.path !== null &&
                    player.libraryItem.state.video_id === player.selected.streamRequest.path.id ?
                    player.libraryItem.state.timeOffset
                    :
                    0,
                forceTranscoding: false,
                maxAudioChannels: settings.surroundSound ? 32 : 2,
                hardwareDecoding: settings.hardwareDecoding,
                assSubtitlesStyling: settings.assSubtitlesStyling,
                gpuVideoProcessing: settings.gpuVideoProcessing && platform.shell.capabilities.gpuVideoProcessing,
                videoMode: settings.videoMode,
                platform: platform.name,
                streamingServerURL: null,
                seriesInfo: player.seriesInfo,
            }, {
                chromecastTransport: services.chromecast.active ? services.chromecast.transport : null,
                shellTransport: platform.shell.active ? platform.shell : null,
            });
            return;
        }

        if (player.selected && player.stream?.type === 'Ready' && streamingServer.settings?.type !== 'Loading') {
            // An addon may hand us a bridge URL wrapped in another unsigned /proxy URL: use the signed one.
            const addonBridgeUrl = unwrapBridgeUrl(player.stream.content.url);
            video.load({
                stream: {
                    ...player.stream.content,
                    ...(addonBridgeUrl ? { url: addonBridgeUrl, infoHash: null, fileIdx: null, ...(isDirectFileUrl(addonBridgeUrl) ? {} : { behaviorHints: HLS_BEHAVIOR_HINTS }) } : {}),
                    subtitles: streamSubtitles
                },
                autoplay: true,
                time: !isEpg && player.libraryItem !== null &&
                    player.selected.streamRequest !== null &&
                    player.selected.streamRequest.path !== null &&
                    player.libraryItem.state.video_id === player.selected.streamRequest.path.id ?
                    player.libraryItem.state.timeOffset
                    :
                    0,
                forceTranscoding: forceTranscoding || casting,
                maxAudioChannels: settings.surroundSound ? 32 : 2,
                hardwareDecoding: settings.hardwareDecoding,
                assSubtitlesStyling: settings.assSubtitlesStyling,
                gpuVideoProcessing: settings.gpuVideoProcessing && platform.shell.capabilities.gpuVideoProcessing,
                videoMode: settings.videoMode,
                platform: platform.name,
                streamingServerURL: streamingServer.baseUrl && !addonBridgeUrl ?
                    casting ?
                        streamingServer.baseUrl
                        :
                        streamingServer.selected.transportUrl
                    :
                    null,
                seriesInfo: player.seriesInfo,
            }, {
                chromecastTransport: services.chromecast.active ? services.chromecast.transport : null,
                shellTransport: platform.shell.active ? platform.shell : null,
            });
        }
    }, [streamingServer.baseUrl, player.selected, player.stream, streamSubtitles, forceTranscoding, casting, cancelKeyboardSeek, directStream, sgStatus, sgUrl]);

    React.useEffect(() => {
        !seeking && timeChanged(video.state.time, video.state.duration, video.state.manifest?.name);
    }, [video.state.time, video.state.duration, video.state.manifest, seeking]);

    React.useEffect(() => {
        if (playingOnExternalDevice.current && video.state.paused === false) {
            onPauseRequested();
        } else if (video.state.paused !== null) {
            pausedChanged(video.state.paused);
        }
    }, [video.state.paused]);

    React.useEffect(() => {
        videoParamsChanged(video.state.videoParams);
    }, [video.state.videoParams]);

    React.useEffect(() => {
        if (!isCasting()) playingOnExternalDevice.current = false;
    }, [video.state.stream, isCasting]);

    React.useEffect(() => {
        if (requestedVideoScale.current === player.videoScale) {
            requestedVideoScale.current = null;
        }
        if (player.selected === null) {
            requestedVideoScale.current = null;
            persistedVideoScale.current = { stream: null, scale: null };
            return;
        }
        if (!video.state.manifest?.props.includes('videoScale') || video.state.stream === null) {
            return;
        }
        if (persistedVideoScale.current.stream !== video.state.stream) {
            persistedVideoScale.current = { stream: video.state.stream, scale: null };
        }

        const sessionScale = requestedVideoScale.current ?? player.videoScale;
        const scale = sessionScale ?? player.streamState?.videoScale ?? 'contain';

        if (video.state.videoScale !== scale) {
            video.setVideoScale(scale);
        }
        if (sessionScale &&
            player.streamState?.videoScale !== sessionScale &&
            persistedVideoScale.current.scale !== sessionScale) {
            persistedVideoScale.current.scale = sessionScale;
            streamStateChanged({ videoScale: sessionScale });
        }
    }, [player.selected, player.streamState?.videoScale, player.videoScale, video.state.manifest, video.state.stream, video.state.videoScale, streamStateChanged]);

    React.useEffect(() => {
        if (!Array.isArray(video.state.audioTracks) || video.state.audioTracks.length === 0) {
            closeAudioMenu();
        }
    }, [video.state.audioTracks]);

    React.useEffect(() => {
        if (video.state.playbackSpeed === null) {
            closeSpeedMenu();
        }
    }, [video.state.playbackSpeed]);

    React.useEffect(() => {
        const toastFilter = (item) => item?.dataset?.type === 'CoreEvent';
        toast.addFilter(toastFilter);
        const onCastStateChange = () => {
            setCasting(services.chromecast.active && services.chromecast.transport.getCastState() === cast.framework.CastState.CONNECTED);
        };
        const onChromecastServiceStateChange = () => {
            onCastStateChange();
            if (services.chromecast.active) {
                services.chromecast.transport.on(
                    cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                    onCastStateChange
                );
            }
        };
        const onCoreEvent = (name) => {
            if (name === 'PlayingOnDevice') {
                playingOnExternalDevice.current = true;
                onPauseRequested();
            }
        };
        services.chromecast.on('stateChanged', onChromecastServiceStateChange);
        core.on('event', onCoreEvent);
        onChromecastServiceStateChange();
        return () => {
            toast.removeFilter(toastFilter);
            services.chromecast.off('stateChanged', onChromecastServiceStateChange);
            core.off('event', onCoreEvent);
            if (services.chromecast.active) {
                services.chromecast.transport.off(
                    cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                    onCastStateChange
                );
            }
        };
    }, []);

    React.useEffect(() => {
        if (settings.pauseOnMinimize && (platform.shell.state.windowClosed || platform.shell.state.windowHidden)) {
            onPauseRequested();
        }
    }, [settings.pauseOnMinimize, platform.shell.state.windowClosed, platform.shell.state.windowHidden]);

    React.useEffect(() => {
        if (video.state.stream === null || typeof player?.title !== 'string') {
            discordTimestamps.current = EMPTY_DISCORD_TIMESTAMPS;
            discord.setActivity(null);
            return;
        }

        const { activity, timestamps } = getPlaybackDiscordActivity({
            title: player.title,
            image: metaItemContent?.poster || metaItemContent?.background || null,
            paused: video.state.paused,
            time: video.state.time,
            duration: video.state.duration,
            timestamps: discordTimestamps.current,
        });

        discordTimestamps.current = timestamps;
        discord.setActivity(activity);
    }, [discord.setActivity, player?.title, metaItemContent, video.state.duration, video.state.paused, video.state.stream, video.state.time]);

    React.useEffect(() => {
        return () => {
            discord.setActivity(null);
        };
    }, [discord.setActivity]);

    useMediaSession(video.state, player, fullscreen, onPlayRequested, onPauseRequested, onNextVideoRequested);

    React.useEffect(() => {
        const onMediaKey = (action) => {
            switch (action) {
                case 'play-pause':
                    if (video.state.paused !== null) {
                        video.state.paused ? onPlayRequested() : onPauseRequested();
                    }
                    break;
                case 'play':
                    onPlayRequested();
                    break;
                case 'pause':
                    onPauseRequested();
                    break;
                case 'next-track':
                    if (!isEpg && player.nextVideo !== null) {
                        video.setTime(0);
                        onNextVideoRequested();
                    }
                    break;
            }
        };
        platform.shell.on('media-key', onMediaKey);
        return () => platform.shell.off('media-key', onMediaKey);
    }, [isEpg, video.state.paused, player.nextVideo, onPlayRequested, onPauseRequested, onNextVideoRequested]);

    useShortcut('seekForward', React.useCallback((combo) => {
        const seekDuration = combo === 1 ? settings.seekShortTimeDuration : settings.seekTimeDuration;
        onKeyboardSeekRequested(seekDuration);
    }, [settings.seekShortTimeDuration, settings.seekTimeDuration, onKeyboardSeekRequested]), !menusOpen && canSeek);

    useShortcut('seekBackward', React.useCallback((combo) => {
        const seekDuration = combo === 1 ? settings.seekShortTimeDuration : settings.seekTimeDuration;
        onKeyboardSeekRequested(-seekDuration);
    }, [settings.seekShortTimeDuration, settings.seekTimeDuration, onKeyboardSeekRequested]), !menusOpen && canSeek);

    useShortcut('mute', React.useCallback(() => {
        video.state.muted === true ? onUnmuteRequested() : onMuteRequested();
    }, [onMuteRequested, onUnmuteRequested, video.state.muted]), !menusOpen);

    useShortcut('volume', React.useCallback((combo) => {
        if (video.state.volume !== null) {
            const volume = combo === 0 ? Math.min(video.state.volume + 5, 200) : Math.max(video.state.volume - 5, 0);
            onVolumeChangeRequested(volume);
        }
    }, [onVolumeChangeRequested, video.state.volume]), !menusOpen);

    useShortcut('audioMenu', React.useCallback(() => {
        closeMenus();
        if (video.state?.audioTracks?.length > 0) {
            toggleAudioMenu();
        }
    }, [closeMenus, video.state?.audioTracks?.length, toggleAudioMenu]));

    useShortcut('infoMenu', React.useCallback(() => {
        closeMenus();
        if (player.metaItem?.type === 'Ready') {
            toggleSideDrawer();
        }
    }, [closeMenus, player.metaItem?.type, toggleSideDrawer]));

    useShortcut('speedMenu', React.useCallback(() => {
        closeMenus();
        if (video.state.playbackSpeed !== null) {
            toggleSpeedMenu();
        }
    }, [closeMenus, video.state.playbackSpeed, toggleSpeedMenu]));

    useShortcut('speed', React.useCallback((combo) => {
        if (video.state.playbackSpeed !== null) {
            const speed = combo === 0 ? Math.max(video.state.playbackSpeed - 0.25, 0.25) : Math.min(video.state.playbackSpeed + 0.25, 2);
            onPlaybackSpeedChanged(speed);
        }
    }, [video.state.playbackSpeed, onPlaybackSpeedChanged]), !menusOpen);

    useShortcut('videoScale', onVideoScaleChanged, !menusOpen && video.state.videoScale !== null);

    const selectedStream = player.selected?.stream;
    const statisticsMenuAvailable = streamingServer?.statistics?.type !== 'Err'
        && typeof selectedStream?.infoHash === 'string';

    const finishDetailsHold = React.useCallback(() => {
        const hold = detailsHold.current;
        if (hold === null) return null;

        detailsHold.current = null;
        if (hold.phase === 'pending') {
            clearTimeout(hold.timer);
        } else {
            closeStatisticsMenu();
        }
        return hold.phase;
    }, [closeStatisticsMenu]);

    const releaseDetailsHold = React.useCallback(() => {
        if (finishDetailsHold() !== 'pending') return;

        closeMenus();
        if (statisticsMenuAvailable) {
            toggleStatisticsMenu();
        }
    }, [finishDetailsHold, closeMenus, statisticsMenuAvailable, toggleStatisticsMenu]);

    useShortcut('statisticsMenu', React.useCallback(() => {
        if (detailsHold.current !== null || isPlaybackSpeedHoldActive()) return;

        const hold = { phase: 'pending', timer: null };
        hold.timer = setTimeout(() => {
            hold.phase = 'held';
            hold.timer = null;
            if (statisticsMenuAvailable) {
                closeMenus();
                openStatisticsMenu();
            }
        }, HOLD_DELAY);
        detailsHold.current = hold;
    }, [statisticsMenuAvailable, closeMenus, openStatisticsMenu, isPlaybackSpeedHoldActive]), routeFocused);

    useShortcut('playNext', React.useCallback(() => {
        closeMenus();
        if (!isEpg && player.nextVideo !== null) {
            nextVideo();
            const deepLinks = player.nextVideo.deepLinks;
            handleNextVideoNavigation(deepLinks, false, false);
        }
    }, [isEpg, closeMenus, player.nextVideo, nextVideo, handleNextVideoNavigation]));

    useShortcut('exit', React.useCallback(() => {
        closeMenus();
        // When escExitFullscreen is enabled, FullscreenProvider handles the first
        // Escape press by leaving fullscreen. Only skip navigating back in that case,
        // otherwise Escape would never exit the player in windowed mode.
        if (settings.escExitFullscreen && fullscreen) {
            return;
        }
        goBack();
    }, [closeMenus, settings.escExitFullscreen, fullscreen, goBack]));

    React.useLayoutEffect(() => {
        if (!routeFocused) {
            finishDetailsHold();
        }

        const onKeyDown = (e) => {
            const keyboardKey = getKeyboardShortcutKey(e);
            if (keyboardKey !== 'Space' || e.repeat) return;
            if (menusOpen || detailsHold.current !== null || e.ctrlKey || e.metaKey || e.altKey) return;

            startPlaybackSpeedHold('keyboard');
        };

        const onKeyUp = (e) => {
            const keyboardKeys = getKeyboardShortcutKeys(e);

            if (keyboardKeys.includes('KeyD') || keyboardKeys.includes('D')) {
                releaseDetailsHold();
                return;
            }

            if (!keyboardKeys.includes('Space') && !keyboardKeys.includes('ArrowRight') && !keyboardKeys.includes('ArrowLeft')) return;
            if (e.ctrlKey || e.metaKey || e.altKey) {
                if (keyboardKeys.includes('Space')) finishPlaybackSpeedHold('keyboard');
                return;
            }

            if (keyboardKeys.includes('ArrowRight') || keyboardKeys.includes('ArrowLeft')) {
                releaseKeyboardSeek();
                setImmersed(false);
                setImmersedDebounced(true);
                return;
            }
            if (keyboardKeys.includes('Space')) {
                const phase = finishPlaybackSpeedHold('keyboard');
                if (phase === 'pending' && !menusOpen && video.state.paused !== null) {
                    if (video.state.paused) {
                        onPlayRequested();
                        setSeeking(false);
                    } else {
                        onPauseRequested();
                    }
                }
            }
        };

        const onWheel = ({ deltaY }) => {
            if (menusOpen || video.state.volume === null) return;

            if (deltaY > 0) {
                onVolumeChangeRequested(Math.max(video.state.volume - 5, 0));
            } else {
                if (video.state.volume < 100) {
                    onVolumeChangeRequested(Math.min(video.state.volume + 5, 100));
                }
            }
        };

        const onMouseDownHold = (e) => {
            if (e.button !== 0) return; // left mouse button only
            if (menusOpen || detailsHold.current !== null) return;
            if (controlBarRef.current && controlBarRef.current.contains(e.target)) return;

            startPlaybackSpeedHold('pointer');
        };

        const onMouseUp = (e) => {
            if (e.button !== 0) return;

            finishPlaybackSpeedHold('pointer');
        };

        const onBlur = () => {
            cancelPlaybackSpeedHold();
            finishDetailsHold();
            flushKeyboardSeek();
            setImmersed(false);
            setImmersedDebounced(true);
        };

        if (routeFocused) {
            window.addEventListener('keyup', onKeyUp);
            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('wheel', onWheel);
            window.addEventListener('mousedown', onMouseDownHold);
            window.addEventListener('mouseup', onMouseUp);
            window.addEventListener('blur', onBlur);
        } else {
            cancelKeyboardSeek();
        }
        return () => {
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('wheel', onWheel);
            window.removeEventListener('mousedown', onMouseDownHold);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('blur', onBlur);
        };
    }, [routeFocused, menusOpen, video.state.volume, video.state.paused, finishDetailsHold, releaseDetailsHold, cancelKeyboardSeek, flushKeyboardSeek, releaseKeyboardSeek, startPlaybackSpeedHold, finishPlaybackSpeedHold, cancelPlaybackSpeedHold]);

    React.useEffect(() => {
        video.events.on('error', onError);
        video.events.on('ended', onEnded);

        return () => {
            video.events.off('error', onError);
            video.events.off('ended', onEnded);
        };
    }, [onEnded]);

    React.useLayoutEffect(() => {
        return () => {
            clearTimeout(detailsHold.current?.timer);
            setImmersedDebounced.cancel();
            onPlayRequestedDebounced.cancel();
            onPauseRequestedDebounced.cancel();
        };
    }, []);

    return (
        <div ref={containerRef} className={classnames(styles['player-container'], { [styles['overlayHidden']]: overlayHidden })}
            onMouseDown={onContainerMouseDown}
            onMouseMove={onContainerMouseMove}
            onMouseOver={onContainerMouseMove}
            onMouseLeave={onContainerMouseLeave}>
            <Video
                ref={video.containerRef}
                className={styles['layer']}
                onClick={onVideoClick}
                onDoubleClick={onVideoDoubleClick}
            />
            {
                !video.state.loaded ?
                    <div className={classnames(styles['layer'], styles['background-layer'])}>
                        <img className={styles['image']} src={metaItemContent?.background} />
                    </div>
                    :
                    null
            }
            {
                (video.state.buffering || !video.state.loaded) && !error ?
                    <Buffering
                        ref={bufferingRef}
                        className={classnames(styles['layer'], styles['buffering-layer'])}
                        logo={metaItemContent?.logo}
                        progress={statistics.progress}
                    />
                    :
                    null
            }
            {
                error !== null ?
                    <Error
                        ref={errorRef}
                        className={classnames(styles['layer'], styles['error-layer'])}
                        stream={video.state.stream}
                        {...error}
                    />
                    :
                    null
            }
            {
                menusOpen ?
                    <div className={styles['layer']} />
                    :
                    null
            }
            {
                video.state.volume !== null && overlayHidden ?
                    <VolumeChangeIndicator
                        muted={video.state.muted}
                        volume={video.state.volume}
                    />
                    :
                    null
            }
            <ContextMenu on={[video.containerRef, bufferingRef, errorRef]} autoClose>
                <OptionsMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    stream={player?.selected?.stream}
                    playbackDevices={playbackDevices}
                    extraSubtitlesTracks={extraSubtitleTracks}
                    selectedExtraSubtitlesTrackId={selectedExtraSubtitleTrackId}
                />
            </ContextMenu>
            <HorizontalNavBar
                className={classnames(styles['layer'], styles['nav-bar-layer'])}
                title={player.title !== null ? player.title : ''}
                backButton={true}
                fullscreenButton={true}
                hdrInfo={video.state.hdrInfo}
                onMouseMove={onBarMouseMove}
                onMouseOver={onBarMouseMove}
            />
            {
                player.metaItem?.type === 'Ready' ?
                    <SideDrawerButton
                        className={classnames(styles['layer'], styles['side-drawer-button-layer'])}
                        onClick={toggleSideDrawer}
                    />
                    :
                    null
            }
            <ControlBar
                ref={controlBarRef}
                className={classnames(styles['layer'], styles['control-bar-layer'])}
                paused={video.state.paused}
                time={keyboardSeekTime ?? video.state.time}
                duration={video.state.duration}
                buffered={video.state.buffered}
                volume={video.state.volume}
                muted={video.state.muted}
                playbackSpeed={video.state.playbackSpeed}
                subtitlesTracks={allSubtitleTracks}
                audioTracks={video.state.audioTracks}
                metaItem={player.metaItem}
                nextVideo={isEpg ? null : player.nextVideo}
                stream={player.selected !== null ? player.selected.stream : null}
                statisticsAvailable={statisticsMenuAvailable}
                onPlayRequested={onPlayRequested}
                onPauseRequested={onPauseRequested}
                onNextVideoRequested={onNextVideoRequested}
                onMuteRequested={onMuteRequested}
                onUnmuteRequested={onUnmuteRequested}
                onVolumeChangeRequested={onVolumeChangeRequested}
                onSeekRequested={onSeekRequested}
                onToggleOptionsMenu={toggleOptionsMenu}
                shellCastSupported={shellCastSupported}
                onToggleCastDevicesMenu={toggleCastDevicesMenu}
                remoteMethods={remoteMethods}
                videoElement={videoElement}
                casting={casting}
                onToggleSubtitlesMenu={toggleSubtitlesMenu}
                onToggleAudioMenu={toggleAudioMenu}
                onToggleSpeedMenu={toggleSpeedMenu}
                videoScale={video.state.videoScale}
                videoScaleLabel={VIDEO_SCALE_LABELS[video.state.videoScale || 'contain']}
                live={livePlayback}
                liveTiming={video.state.live}
                seekable={canSeek}
                buffering={video.state.buffering || !video.state.loaded}
                onVideoScaleChanged={onVideoScaleChanged}
                onToggleStatisticsMenu={toggleStatisticsMenu}
                onToggleSideDrawer={toggleSideDrawer}
                onMouseMove={onBarMouseMove}
                onMouseOver={onBarMouseMove}
                onTouchEnd={onContainerMouseLeave}
            />
            <Indicator
                className={classnames(styles['layer'], styles['indicator-layer'])}
                videoState={video.state}
                disabled={subtitlesMenuOpen || speedMenuOpen}
            />
            {
                nextVideoPopupOpen ?
                    <NextVideoPopup
                        className={classnames(styles['layer'], styles['menu-layer'])}
                        metaItem={metaItemContent}
                        nextVideo={upcomingVideo}
                        isEpg={isEpg}
                        onDismiss={onDismissNextVideoPopup}
                        onNextVideoRequested={isEpg ? undefined : onNextVideoRequested}
                    />
                    :
                    null
            }
            <Transition when={statisticsMenuOpen} name={'fade'}>
                <StatisticsMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    {...statistics}
                />
            </Transition>
            <Transition when={castDevicesMenuOpen} name={'fade'}>
                <CastDevicesMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    devices={castDevices}
                    loading={castDevicesLoading}
                    methods={remoteMethods}
                    onDeviceSelected={onCastDeviceSelected}
                />
            </Transition>
            <Transition when={sideDrawerOpen} name={'slide-left'}>
                <SideDrawer
                    className={classnames(styles['layer'], styles['side-drawer-layer'])}
                    metaItem={metaItemContent}
                    seriesInfo={player.seriesInfo}
                    isEpg={isEpg}
                    closeSideDrawer={closeSideDrawer}
                    selected={player.selected?.streamRequest?.path?.id}
                />
            </Transition>
            <Transition when={subtitlesMenuOpen} name={'fade'}>
                <SubtitlesMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    {...subtitlesMenuProps}
                />
            </Transition>
            <Transition when={audioMenuOpen} name={'fade'}>
                <AudioMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    audioTracks={video.state.audioTracks}
                    selectedAudioTrackId={video.state.selectedAudioTrackId}
                    onAudioTrackSelected={onAudioTrackSelected}
                />
            </Transition>
            <Transition when={speedMenuOpen} name={'fade'}>
                <SpeedMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    playbackSpeed={video.state.playbackSpeed}
                    onPlaybackSpeedChanged={onPlaybackSpeedChanged}
                />
            </Transition>
            <Transition when={optionsMenuOpen} name={'fade'}>
                <OptionsMenu
                    className={classnames(styles['layer'], styles['menu-layer'])}
                    stream={player.selected?.stream}
                    playbackDevices={playbackDevices}
                    extraSubtitlesTracks={extraSubtitleTracks}
                    selectedExtraSubtitlesTrackId={selectedExtraSubtitleTrackId}
                />
            </Transition>

            {DEBUG_ENABLED ? (
                <div style={{position:'fixed',bottom:'10px',left:'10px',right:'10px',maxHeight:'40vh',background:'rgba(0,0,0,0.8)',color:'#0f0',fontFamily:'monospace',fontSize:'10px',zIndex:99999,overflow:'auto',padding:'8px',border:'1px solid #0f0',userSelect:'text',whiteSpace:'pre-wrap',wordBreak:'break-all'}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:'4px'}}>
                        <span>{t('DEBUG_PANEL', { defaultValue: 'DEBUG PANEL (?debug=1)' })}</span>
                        <button onClick={()=>{
                            try {
                                const text = (window.__PLAYER_DEBUG_LOGS||[]).join('\n');
                                navigator.clipboard.writeText(text);
                            } catch(e){}
                        }} style={{background:'#333',color:'#0f0',border:'1px solid #0f0',padding:'2px 6px'}}>{t('DEBUG_COPY_LOG', { defaultValue: 'Copy log' })}</button>
                    </div>
                    <div id="__player_debug_content"></div>
                </div>
            ) : null}
        </div>
    );
};

const PlayerFallback = () => (
    <div className={classnames(styles['player-container'])} />
);

module.exports = withCoreSuspender(Player, PlayerFallback);
