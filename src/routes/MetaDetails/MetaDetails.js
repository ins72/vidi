// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { useParams, useLocation, useNavigate } = require('react-router');
const { useTranslation } = require('react-i18next');
const classnames = require('classnames');
const { useCore } = require('stremio/core');
const { useContentGamepadNavigation } = require('stremio/services/GamepadNavigation');
const { withCoreSuspender, useProfile } = require('stremio/common');
const usePlayerUrl = require('stremio/common/usePlayerUrl');
const { useNavigateWithOrigin } = require('stremio-router');
const { default: toPath } = require('stremio-router/toPath');
const { HorizontalNavBar, DelayedRenderer, Image, MetaPreview } = require('stremio/components');
const StreamsList = require('./StreamsList');
const VideosList = require('./VideosList');
const { default: LiveTvDetails } = require('./LiveTvDetails');
const { default: LiveTvPlaceholder } = require('./LiveTvDetails/Placeholder');
const useMetaDetails = require('./useMetaDetails');
const useSeason = require('./useSeason');
const { default: useExternalPlayerCallback } = require('./useExternalPlayerCallback');
const styles = require('./styles');

const GAMEPAD_HANDLER_ID = 'metadetails';

// Episode ids come in a few shapes: the full '<imdb>:<season>:<episode>' id, or a shortened
// variant that only carries the season and the episode (e.g. '18:4' or 'A18:4').
const parseEpisodeVideoId = (id, videoId) => {
    if (typeof videoId !== 'string' || videoId.length === 0) return null;
    if (/^tt\d+:\d+:\d+$/.test(videoId)) return videoId;
    if (typeof id !== 'string' || !/^tt\d+$/.test(id)) return null;

    const numbers = videoId.match(/\d+/g);
    if (numbers === null || numbers.length < 2) return null;

    const season = numbers[numbers.length - 2];
    const episode = numbers[numbers.length - 1];

    return `${id}:${season}:${episode}`;
};

const MetaDetails = () => {
    const { type, id, videoId } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const { getStoredOrigin } = useNavigateWithOrigin();
    const contentRef = React.useRef(null);
    const videosScrollMemoryRef = React.useRef(null);
    const { t } = useTranslation();
    const core = useCore();
    const profile = useProfile();
    const urlParams = React.useMemo(() => ({
        type,
        id,
        videoId
    }), [type, id, videoId]);
    const metaDetails = useMetaDetails(urlParams);
    const readyMeta = metaDetails.metaItem?.content.type === 'Ready' ? metaDetails.metaItem.content.content : null;
    const metaAddonUrl = metaDetails.metaItem?.addon.transportUrl;
    const isEpgProvider = React.useMemo(() => {
        return profile.addons.some((addon) => addon.transportUrl === metaAddonUrl && addon.manifest.behaviorHints?.epgProvider === true);
    }, [profile.addons, metaAddonUrl]);
    const isLiveMeta = isEpgProvider && readyMeta !== null && (readyMeta.behaviorHints?.isLive === true || readyMeta.type === 'tv');
    const [season, setSeason] = useSeason(urlParams);
    useExternalPlayerCallback(urlParams, metaDetails);
    const [metaPath, streamPath] = React.useMemo(() => {
        return metaDetails.selected !== null ?
            [metaDetails.selected.metaPath, metaDetails.selected.streamPath]
            :
            [null, null];
    }, [metaDetails.selected]);
    const video = React.useMemo(() => {
        return streamPath !== null && metaDetails.metaItem !== null && metaDetails.metaItem.content.type === 'Ready' ?
            metaDetails.metaItem.content.content.videos.reduce((result, video) => {
                if (video.id === streamPath.id) {
                    return video;
                }

                return result;
            }, null)
            :
            null;
    }, [metaDetails.metaItem, streamPath]);
    // "Watch now" opens the player for this content through the streamgrabber bridge.
    // The player url must start with an encoded stream, otherwise the core cannot resolve the
    // meta and the player renders without metadata. A stream's player deep link has exactly that
    // shape: /player/<encoded stream>/<stream addon>/<meta addon>/<type>/<id>/<videoId>
    const watchTarget = React.useMemo(() => {
        const content = metaDetails.metaItem !== null && metaDetails.metaItem.content.type === 'Ready' ?
            metaDetails.metaItem.content.content
            :
            null;
        if (content === null) return null;

        const imdbId = typeof content.id === 'string' && /^tt\d+$/.test(content.id) ? content.id : null;
        if (imdbId === null) return null;

        const isSeries = type === 'series';
        let videoId = imdbId;
        if (isSeries) {
            const candidates = [
                metaDetails.libraryItem?.state?.video_id,
                streamPath !== null ? streamPath.id : null,
                metaDetails.selected?.streamPath?.id
            ];
            videoId = candidates.find((id) => typeof id === 'string' && /^tt\d+:\d+:\d+$/.test(id)) || null;
            if (videoId === null) {
                const videos = Array.isArray(content.videos) ? content.videos : [];
                const firstEpisode = videos.find((v) => typeof v?.id === 'string' && /^tt\d+:\d+:\d+$/.test(v.id));
                videoId = firstEpisode ? firstEpisode.id : null;
            }
            if (videoId === null) return null;
        }

        const metaTransportUrl = metaDetails.metaItem.addon?.transportUrl;
        if (typeof metaTransportUrl !== 'string' || metaTransportUrl.length === 0) return null;

        const streams = Array.isArray(metaDetails.streams) ? metaDetails.streams : [];
        const streamTransportUrl = streams.length > 0 && typeof streams[0]?.addon?.transportUrl === 'string' ?
            streams[0].addon.transportUrl
            :
            metaTransportUrl;

        return {
            imdbId,
            isSeries,
            videoId,
            metaTransportUrl,
            streamTransportUrl
        };
    }, [metaDetails, type, streamPath]);
    // A stream from the addon list already carries the encoded stream in its player deep link.
    const watchDeepLink = React.useMemo(() => {
        const streams = Array.isArray(metaDetails.streams) ? metaDetails.streams : [];
        let fallbackLink = null;
        let httpLink = null;
        for (const stream of streams) {
            const player = stream?.deepLinks?.player;
            if (typeof player !== 'string' || player.length === 0 || !player.includes('/player/')) continue;
            const url = typeof stream?.url === 'string' ? stream.url : '';
            // prefer a direct http(s) source over a torrent, the streamgrabber url replaces it anyway
            if (httpLink === null && /^https?:/i.test(url)) {
                httpLink = player;
                break;
            }
            if (fallbackLink === null) fallbackLink = player;
        }
        const playerDeepLink = httpLink !== null ? httpLink : fallbackLink;
        return playerDeepLink !== null ?
            (playerDeepLink.startsWith('#') ? playerDeepLink : `#${playerDeepLink}`)
            :
            null;
    }, [metaDetails.streams]);
    // No stream available: encode a placeholder stream ourselves, so the core still gets a valid
    // stream and can load the metadata.
    const buildPlayerUrl = usePlayerUrl();
    const encodedWatchHref = React.useMemo(() => {
        if (watchDeepLink !== null || watchTarget === null) return null;
        const { imdbId, isSeries, videoId, metaTransportUrl, streamTransportUrl } = watchTarget;
        return buildPlayerUrl({
            type: isSeries ? 'series' : 'movie',
            id: imdbId,
            videoId,
            streamTransportUrl,
            metaTransportUrl
        });
    }, [watchDeepLink, watchTarget, buildPlayerUrl]);
    const watchHref = watchDeepLink !== null ? watchDeepLink : encodedWatchHref;
    // Legacy deep links (#/detail/series/<id>/<videoId>) point at a single episode: open the
    // player for it instead of the meta details page.
    const legacyPlayerHref = React.useMemo(() => {
        if (!location.pathname.startsWith('/detail/')) return null;
        const episodeId = parseEpisodeVideoId(urlParams.id, urlParams.videoId);
        if (episodeId === null) return null;
        const content = metaDetails.metaItem !== null && metaDetails.metaItem.content.type === 'Ready' ?
            metaDetails.metaItem.content.content
            :
            null;
        const metaTransportUrl = metaDetails.metaItem?.addon?.transportUrl;
        if (content === null || typeof metaTransportUrl !== 'string') return null;
        return buildPlayerUrl({
            type: type === 'series' ? 'series' : 'movie',
            id: content.id,
            videoId: episodeId,
            streamTransportUrl: metaTransportUrl,
            metaTransportUrl
        });
    }, [location.pathname, urlParams.id, urlParams.videoId, type, metaDetails.metaItem, buildPlayerUrl]);
    React.useEffect(() => {
        if (legacyPlayerHref !== null) {
            navigate(toPath(legacyPlayerHref), { replace: true });
        }
    }, [legacyPlayerHref, navigate]);
    const externalPlayerCallbackCanMarkWatched = React.useMemo(() => {
        return typeof video?.id === 'string' &&
            metaDetails.libraryItem?.state?.video_id === video.id &&
            metaDetails.libraryItem?.state?.duration > 0;
    }, [metaDetails.libraryItem, video]);
    const handleEpisodeSearch = React.useCallback((season, episode) => {
        const searchVideoHash = encodeURIComponent(`${urlParams.id}:${season}:${episode}`);
        const url = location.pathname;
        const searchVideoPath = (urlParams.videoId === undefined || urlParams.videoId === null || urlParams.videoId === '') ?
            url + (!url.endsWith('/') ? '/' : '') + searchVideoHash
            : url.replace(encodeURIComponent(urlParams.videoId), searchVideoHash);
        navigate(searchVideoPath, { replace: true });
    }, [urlParams, location]);
    const addToLibrary = React.useCallback(() => {
        if (metaDetails.metaItem === null || metaDetails.metaItem.content.type !== 'Ready') {
            return;
        }

        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'AddToLibrary',
                args: metaDetails.metaItem.content.content
            }
        });
    }, [metaDetails]);
    const removeFromLibrary = React.useCallback(() => {
        if (metaDetails.metaItem === null || metaDetails.metaItem.content.type !== 'Ready') {
            return;
        }

        core.transport.dispatch({
            action: 'Ctx',
            args: {
                action: 'RemoveFromLibrary',
                args: metaDetails.metaItem.content.content.id
            }
        });
    }, [metaDetails]);
    const toggleWatched = React.useCallback(() => {
        if (metaDetails.metaItem === null || metaDetails.metaItem.content.type !== 'Ready') {
            return;
        }

        core.transport.dispatch({
            action: 'MetaDetails',
            args: {
                action: 'MarkAsWatched',
                args: !metaDetails.metaItem.content.content.watched
            }
        });
    }, [metaDetails]);
    const toggleNotifications = React.useCallback(() => {
        if (metaDetails.libraryItem) {
            core.transport.dispatch({
                action: 'Ctx',
                args: {
                    action: 'ToggleLibraryItemNotifications',
                    args: [metaDetails.libraryItem._id, !metaDetails.libraryItem.state.noNotif],
                }
            });
        }
    }, [metaDetails.libraryItem]);
    const seasonOnSelect = React.useCallback((event) => {
        setSeason(event.value);
    }, [setSeason]);
    const renderBackgroundImageFallback = React.useCallback(() => null, []);
    const renderBackground = React.useMemo(() => !!(
        metaPath &&
        metaDetails?.metaItem &&
        metaDetails.metaItem.content.type !== 'Loading' &&
        typeof metaDetails.metaItem.content.content?.background === 'string' &&
        metaDetails.metaItem.content.content.background.length > 0
    ), [metaPath, metaDetails]);
    const originPath = React.useMemo(() => getStoredOrigin(), [getStoredOrigin]);
    useContentGamepadNavigation(contentRef, GAMEPAD_HANDLER_ID);
    if (type === 'tv' && (metaDetails.selected === null || (isEpgProvider && metaDetails.metaItem?.content.type === 'Loading'))) {
        return (
            <div className={styles['metadetails-container']}>
                <HorizontalNavBar
                    className={styles['nav-bar']}
                    backButton={true}
                    fullscreenButton={true}
                    navMenu={true}
                    originPath={originPath}
                />
                <LiveTvPlaceholder />
            </div>
        );
    }
    if (isLiveMeta) {
        return (
            <LiveTvDetails
                key={readyMeta.id}
                className={styles['metadetails-container']}
                contentRef={contentRef}
                meta={readyMeta}
                addonName={metaDetails.metaItem.addon.manifest.name}
                streams={metaDetails.streams}
                onToggleLibrary={readyMeta.inLibrary ? removeFromLibrary : addToLibrary}
            >
                <HorizontalNavBar
                    className={styles['nav-bar']}
                    backButton={true}
                    fullscreenButton={true}
                    navMenu={true}
                    originPath={originPath}
                />
            </LiveTvDetails>
        );
    }
    return (
        <div className={styles['metadetails-container']}>
            {
                renderBackground ?
                    <div className={styles['background-image-layer']}>
                        <Image
                            className={styles['background-image']}
                            src={metaDetails.metaItem.content.content.background}
                            renderFallback={renderBackgroundImageFallback}
                            alt={' '}
                        />
                    </div>
                    :
                    null
            }
            <HorizontalNavBar
                className={styles['nav-bar']}
                backButton={true}
                fullscreenButton={true}
                navMenu={true}
                originPath={originPath}
            />
            <div ref={contentRef} className={styles['metadetails-content']}>
                {
                    metaPath === null ?
                        <DelayedRenderer delay={500}>
                            <div className={styles['meta-message-container']}>
                                <Image className={styles['image']} src={require('/assets/images/empty.png')} alt={' '} />
                                <div className={styles['message-label']}>{t('ERR_NO_META_SELECTED')}</div>
                            </div>
                        </DelayedRenderer>
                        :
                        metaDetails.metaItem === null ?
                            <div className={styles['meta-message-container']}>
                                <Image className={styles['image']} src={require('/assets/images/empty.png')} alt={' '} />
                                <div className={styles['message-label']}>{t('ERR_NO_ADDONS_FOR_META')}</div>
                            </div>
                            :
                            metaDetails.metaItem.content.type === 'Err' ?
                                <div className={styles['meta-message-container']}>
                                    <Image className={styles['image']} src={require('/assets/images/empty.png')} alt={' '} />
                                    <div className={styles['message-label']}>{t('ERR_NO_META_FOUND')}</div>
                                </div>
                                :
                                metaDetails.metaItem.content.type === 'Loading' ?
                                    <MetaPreview.Placeholder className={styles['meta-preview']} />
                                    :
                                    <React.Fragment>
                                        <MetaPreview
                                            className={classnames(styles['meta-preview'], 'animation-fade-in')}
                                            name={metaDetails.metaItem.content.content.name}
                                            logo={metaDetails.metaItem.content.content.logo}
                                            runtime={metaDetails.metaItem.content.content.runtime}
                                            releaseInfo={metaDetails.metaItem.content.content.releaseInfo}
                                            released={metaDetails.metaItem.content.content.released}
                                            description={
                                                video !== null && typeof video.overview === 'string' && video.overview.length > 0 ?
                                                    video.overview
                                                    :
                                                    metaDetails.metaItem.content.content.description
                                            }
                                            deepLinks={metaDetails.metaItem.content.content.deepLinks}
                                            links={metaDetails.metaItem.content.content.links}
                                            trailerStreams={metaDetails.metaItem.content.content.trailerStreams}
                                            inLibrary={metaDetails.metaItem.content.content.inLibrary}
                                            toggleInLibrary={metaDetails.metaItem.content.content.inLibrary ? removeFromLibrary : addToLibrary}
                                            watched={metaDetails.metaItem.content.content.watched}
                                            toggleWatched={toggleWatched}
                                            metaId={metaDetails.metaItem.content.content.id}
                                            watchHref={watchHref}
                                            ratingInfo={metaDetails.ratingInfo}
                                        />
                                    </React.Fragment>
                }
                <div className={styles['spacing']} />
                {
                    streamPath !== null && type !== 'movie' ?
                        <StreamsList
                            className={styles['streams-list']}
                            streams={metaDetails.streams}
                            video={video}
                            type={streamPath.type}
                            externalPlayerCallbackCanMarkWatched={externalPlayerCallbackCanMarkWatched}
                            onEpisodeSearch={handleEpisodeSearch}
                        />
                        :
                        metaPath !== null && type !== 'movie' ?
                            <VideosList
                                className={styles['videos-list']}
                                metaItem={metaDetails.metaItem}
                                libraryItem={metaDetails.libraryItem}
                                season={season}
                                selectedVideoId={metaDetails.libraryItem?.state?.video_id}
                                seasonOnSelect={seasonOnSelect}
                                toggleNotifications={toggleNotifications}
                                scrollMemoryRef={videosScrollMemoryRef}
                                titleKey={JSON.stringify([metaPath.type, metaPath.id])}
                            />
                            :
                            null
                }
            </div>
        </div>
    );
};

const MetaDetailsFallback = () => {
    const { type } = useParams();
    return (
        <div className={styles['metadetails-container']}>
            <HorizontalNavBar
                className={styles['nav-bar']}
                backButton={true}
                fullscreenButton={true}
                navMenu={true}
            />
            {type === 'tv' && <LiveTvPlaceholder />}
        </div>
    );
};

module.exports = withCoreSuspender(MetaDetails, MetaDetailsFallback);
