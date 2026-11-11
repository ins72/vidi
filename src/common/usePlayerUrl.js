// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { useCore } = require('stremio/core');

// The core can only load the metadata in the player when the player url starts with an encoded
// stream. When no addon stream is available (e.g. an episode in the season browser, or the
// metadata page without a stream list) a placeholder stream is encoded instead - the player
// replaces the url of the selected stream with the streamgrabber url.
const usePlayerUrl = () => {
    const core = useCore();
    const [encoded, setEncoded] = React.useState(null);

    React.useEffect(() => {
        let active = true;
        core.transport.encodeStream({
            name: 'StreamGrabber',
            description: 'Stream provided via streamgrabber',
            url: `${window.location.origin}/streamgrabber/grab`
        })
            .then((value) => {
                if (active && typeof value === 'string') setEncoded(value);
            })
            .catch(() => {
                if (active) setEncoded(null);
            });
        return () => { active = false; };
    }, [core]);

    const buildPlayerUrl = React.useCallback(({ type, id, videoId, streamTransportUrl, metaTransportUrl }) => {
        if (encoded === null) return null;
        if (typeof type !== 'string' || typeof id !== 'string' || typeof videoId !== 'string') return null;

        const meta = typeof metaTransportUrl === 'string' && metaTransportUrl.length > 0 ? metaTransportUrl : null;
        const stream = typeof streamTransportUrl === 'string' && streamTransportUrl.length > 0 ? streamTransportUrl : meta;
        if (meta === null || stream === null) return null;

        return `#/player/${encodeURIComponent(encoded)}/${encodeURIComponent(stream)}/${encodeURIComponent(meta)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${encodeURIComponent(videoId)}`;
    }, [encoded]);

    return buildPlayerUrl;
};

module.exports = usePlayerUrl;
