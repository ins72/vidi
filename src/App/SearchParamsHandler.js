// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { createPath, useLocation } = require('react-router');
const { useCore } = require('stremio/core');
const { CONSTANTS, withCoreSuspender, useModelState, useProfile, useToast } = require('stremio/common');
const { default: StreamingServerUrlModal } = require('./StreamingServerUrlModal');

const DEFAULT_STREAMING_SERVER_URLS = new Set([
    new URL(CONSTANTS.DEFAULT_STREAMING_SERVER_URL).href,
]);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

const parse = (value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch (_) {
        return null;
    }
};

const normalize = (value) => parse(value)?.href ?? null;
const loopback = (url) => LOOPBACK_HOSTNAMES.has(url.hostname);
const map = ({ streamingServerUrls }) => ({ streamingServerUrls });
const SearchParamsHandler = () => {
    const location = useLocation();
    const core = useCore();
    const profile = useProfile();
    const toast = useToast();
    const { streamingServerUrls } = useModelState({ model: 'ctx', map: map });

    const { searchParams } = new URL(`${window.location.origin}${createPath(location)}${window.location.search}`);
    const streamingServerUrl = searchParams.getAll('streamingServerUrl').pop() ?? null;
    const [requested, set] = React.useState(null);
    const handledStreamingServerUrlRef = React.useRef(null);

    // Always spread the latest settings so two dispatches in one render pass
    // (default redirect + ?streamingServerUrl=) cannot overwrite each other's data.
    const settingsRef = React.useRef(profile.settings);
    settingsRef.current = profile.settings;
    const defaultRedirectedRef = React.useRef(false);

    const apply = React.useCallback((url, { save, notify }) => {
        if (save) {
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'AddServerUrl',
                    args: url,
                },
            });
        }

        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'UpdateSettings',
                args: {
                    ...settingsRef.current,
                    streamingServerUrl: url,
                },
            },
        });

        if (notify) {
            toast.show({
                type: 'success',
                title: `Using streaming server at ${url}`,
                timeout: 4000,
            });
        }
    }, [core, toast]);

    const onConfirm = React.useCallback(() => {
        apply(requested, { save: true, notify: false });
        set(null);
    }, [apply, requested]);

    const onCancel = React.useCallback(() => {
        set(null);
    }, []);

    // The app is served over the internet, so a loopback streaming server
    // (the core default is http://127.0.0.1:11470/) can never work for
    // anyone but the machine running the server. Point it at the public
    // streaming server instead, unless the user picked a public one already.
    React.useEffect(() => {
        const selected = parse(profile.settings.streamingServerUrl);
        if (selected !== null && !loopback(selected)) {
            defaultRedirectedRef.current = false;
            return;
        }
        // Redirect once per loopback state; re-running on every settings update
        // re-dispatched AddServerUrl/UpdateSettings until the core caught up.
        if (defaultRedirectedRef.current) return;
        defaultRedirectedRef.current = true;
        apply(new URL(CONSTANTS.DEFAULT_STREAMING_SERVER_URL).href, { save: true, notify: false });
    }, [apply, profile.settings.streamingServerUrl]);

    React.useEffect(() => {
        if (handledStreamingServerUrlRef.current === streamingServerUrl) {
            return;
        }
        handledStreamingServerUrlRef.current = streamingServerUrl ?? null;
        set(null);

        const parsed = parse(streamingServerUrl);
        if (parsed === null) {
            return;
        }

        const normalized = parsed.href;
        const selected = parse(profile.settings.streamingServerUrl);
        if (normalized === selected?.href) {
            return;
        }

        if (loopback(parsed) && selected !== null && !loopback(selected)) {
            return;
        }

        if (DEFAULT_STREAMING_SERVER_URLS.has(normalized)) {
            apply(normalized, { save: true, notify: false });
            return;
        }

        const saved = streamingServerUrls.some(({ url }) => (
            normalize(url) === normalized
        ));
        if (saved) {
            apply(normalized, { save: false, notify: true });
            return;
        }

        if (loopback(parsed)) {
            apply(normalized, { save: true, notify: true });
            return;
        }

        set(normalized);
    }, [apply, profile.settings.streamingServerUrl, streamingServerUrl, streamingServerUrls]);

    return requested !== null ?
        <StreamingServerUrlModal
            url={requested}
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
        :
        null;
};

module.exports = withCoreSuspender(SearchParamsHandler);
