// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const { Button } = require('stremio/components');
const { useServices } = require('stremio/services');
const SeekBar = require('./SeekBar');
const VolumeSlider = require('./VolumeSlider');
const styles = require('./styles');
const { useBinaryState, usePlatform } = require('stremio/common');
const { t } = require('i18next');

const VIDEO_SCALE_ICONS = {
    contain: 'video-scale-fit',
    cover: 'video-scale-crop',
    fill: 'video-scale-stretch'
};

const ControlBar = React.forwardRef(({
    className,
    paused,
    time,
    duration,
    buffered,
    volume,
    muted,
    playbackSpeed,
    subtitlesTracks,
    audioTracks,
    metaItem,
    nextVideo,
    stream,
    statisticsAvailable,
    onPlayRequested,
    onPauseRequested,
    onNextVideoRequested,
    onMuteRequested,
    onUnmuteRequested,
    onVolumeChangeRequested,
    onSeekRequested,
    onToggleSubtitlesMenu,
    onToggleAudioMenu,
    onToggleSpeedMenu,
    onToggleSideDrawer,
    onToggleOptionsMenu,
    onToggleCastDevicesMenu,
    videoScale,
    videoScaleLabel,
    live,
    liveTiming,
    seekable,
    buffering,
    onVideoScaleChanged,
    onToggleStatisticsMenu,
    onTouchEnd,
    remoteMethods,
    casting,
    ...props
}, ref) => {
    const { chromecast } = useServices();
    const platform = usePlatform();
    const [buttonsMenuOpen, , , toggleButtonsMenu] = useBinaryState(false);
    const onSubtitlesButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.subtitlesMenuClosePrevented = true;
    }, []);
    const onAudioButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.audioMenuClosePrevented = true;
    }, []);
    const onSpeedButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.speedMenuClosePrevented = true;
    }, []);
    const onVideosButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.videosMenuClosePrevented = true;
    }, []);
    const onOptionsButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.optionsMenuClosePrevented = true;
    }, []);
    const onStatisticsButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.statisticsMenuClosePrevented = true;
    }, []);

    const onPlayPauseButtonClick = React.useCallback(() => {
        if (paused) {
            if (typeof onPlayRequested === 'function') {
                onPlayRequested();
            }
        } else {
            if (typeof onPauseRequested === 'function') {
                onPauseRequested();
            }
        }
    }, [paused, onPlayRequested, onPauseRequested]);
    const onNextVideoButtonClick = React.useCallback(() => {
        if (nextVideo !== null && typeof onNextVideoRequested === 'function') {
            onNextVideoRequested();
        }
    }, [nextVideo, onNextVideoRequested]);
    const onMuteButtonClick = React.useCallback(() => {
        if (muted) {
            if (typeof onUnmuteRequested === 'function') {
                onUnmuteRequested();
            }
        } else {
            if (typeof onMuteRequested === 'function') {
                onMuteRequested();
            }
        }
    }, [muted, onMuteRequested, onUnmuteRequested]);

    const methods = React.useMemo(() => Array.isArray(remoteMethods) ? remoteMethods : [], [remoteMethods]);

    const castDeviceName = (() => {
        if (!casting || !chromecast || !chromecast.transport || typeof chromecast.transport.getCastDevice !== 'function') return null;
        try {
            const device = chromecast.transport.getCastDevice();
            return device && device.friendlyName ? device.friendlyName : null;
        } catch (_e) {
            return null;
        }
    })();

    const onCastButtonClick = React.useCallback(() => {
        if (casting) {
            // Stop whichever path is active. Chromecast ends its session; AirPlay
            // re-opens the picker (that is how the user disconnects on iOS);
            // desktop-shell casting is stopped by the streaming server.
            if (chromecast && chromecast.transport && typeof chromecast.transport.endCurrentSession === 'function') {
                try {
                    chromecast.transport.endCurrentSession(true);
                } catch (_e) {
                    void _e;
                }
            }
            if (typeof onToggleCastDevicesMenu === 'function') {
                onToggleCastDevicesMenu();
            }
            return;
        }
        if (methods.length === 1) {
            const m = methods[0];
            // Shell's start() is a no-op (shell opens the device menu). When shell
            // is the only available method, open the menu so the user can pick a
            // device or see the help sheet. All other methods start directly.
            if (m && m.id === 'shell' && typeof onToggleCastDevicesMenu === 'function') {
                onToggleCastDevicesMenu();
            } else if (m && typeof m.start === 'function') {
                try {
                    m.start();
                } catch (_e) {
                    void _e;
                }
            }
            return;
        }
        if (typeof onToggleCastDevicesMenu === 'function') {
            onToggleCastDevicesMenu();
        }
    }, [casting, methods, onToggleCastDevicesMenu, chromecast]);

    const castTitle = (() => {
        if (casting) {
            if (castDeviceName) return t('PLAYER_CAST_STOP_ON', { defaultValue: 'Stop casting on {{device}}', device: castDeviceName });
            return t('PLAYER_CAST_STOP', { defaultValue: 'Stop casting' });
        }
        if (methods.length === 1) {
            return methods[0].label || t('PLAYER_CAST_TO', { defaultValue: 'Cast to' });
        }
        return t('PLAYER_CAST_DEVICES', { defaultValue: 'Cast to device' });
    })();

    const onCastDevicesButtonMouseDown = React.useCallback((event) => {
        event.nativeEvent.castDevicesMenuClosePrevented = true;
    }, []);

    return (
        <div ref={ref} {...props} onTouchStart={props.onMouseOver} onTouchMove={props.onMouseMove} onTouchEnd={onTouchEnd} className={classnames(className, styles['control-bar-container'])}>
            <SeekBar
                className={styles['seek-bar']}
                time={time}
                duration={duration}
                buffered={buffered}
                onSeekRequested={onSeekRequested}
                playbackSpeed={playbackSpeed}
                live={live}
                liveTiming={liveTiming}
                paused={paused}
                onPlayRequested={onPlayRequested}
                seekable={seekable}
                buffering={buffering}
            />
            <div className={styles['control-bar-buttons-container']}>
                <Button className={classnames(styles['control-bar-button'], { 'disabled': typeof paused !== 'boolean' })} title={paused ? t('PLAYER_PLAY') : t('PLAYER_PAUSE')} tabIndex={-1} onClick={onPlayPauseButtonClick}>
                    <Icon className={styles['icon']} name={typeof paused !== 'boolean' || paused ? 'play' : 'pause'} />
                </Button>
                {
                    nextVideo !== null ?
                        <Button className={classnames(styles['control-bar-button'])} title={t('PLAYER_NEXT_VIDEO')} tabIndex={-1} onClick={onNextVideoButtonClick}>
                            <Icon className={styles['icon']} name={'next'} />
                        </Button>
                        :
                        null
                }
                <Button className={classnames(styles['control-bar-button'], { 'disabled': typeof muted !== 'boolean' })} title={muted ? t('PLAYER_UNMUTE') : t('PLAYER_MUTE')} tabIndex={-1} onClick={onMuteButtonClick}>
                    <Icon
                        className={styles['icon']}
                        name={
                            (typeof muted === 'boolean' && muted) ? 'volume-mute' :
                                (volume === null || isNaN(volume)) ? 'volume-off' :
                                    volume === 0 ? 'volume-mute' :
                                        volume < 30 ? 'volume-low' :
                                            volume < 70 ? 'volume-medium' :
                                                'volume-high'
                        }
                    />
                </Button>
                {
                    !platform.isMobile ?
                        <VolumeSlider
                            className={styles['volume-slider']}
                            volume={volume}
                            muted={muted}
                            onVolumeChangeRequested={onVolumeChangeRequested}
                        />
                        : null
                }
                <div className={styles['spacing']} />
                <Button className={styles['control-bar-buttons-menu-button']} onClick={toggleButtonsMenu}>
                    <Icon className={styles['icon']} name={'more-vertical'} />
                </Button>
                <div className={classnames(styles['control-bar-buttons-menu-container'], { 'open': buttonsMenuOpen })}>
                    {
                        statisticsAvailable &&
                            <Button className={styles['control-bar-button']} tabIndex={-1} onMouseDown={onStatisticsButtonMouseDown} onClick={onToggleStatisticsMenu}>
                                <Icon className={styles['icon']} name={'network'} />
                            </Button>
                    }
                    <Button className={classnames(styles['control-bar-button'], { 'disabled': playbackSpeed === null })} tabIndex={-1} onMouseDown={onSpeedButtonMouseDown} onClick={onToggleSpeedMenu}>
                        <Icon className={styles['icon']} name={'speed'} />
                    </Button>
                    <Button
                        className={classnames(styles['control-bar-button'], { casting: casting })}
                        tabIndex={-1}
                        onMouseDown={onCastDevicesButtonMouseDown}
                        onClick={onCastButtonClick}
                        title={castTitle}
                        disabled={false}
                    >
                        <Icon className={styles['icon']} name={'cast'} />
                    </Button>
                    <Button className={classnames(styles['control-bar-button'], { 'disabled': !Array.isArray(subtitlesTracks) || subtitlesTracks.length === 0 })} tabIndex={-1} onMouseDown={onSubtitlesButtonMouseDown} onClick={onToggleSubtitlesMenu}>
                        <Icon className={styles['icon']} name={'subtitles'} />
                    </Button>
                    <Button className={classnames(styles['control-bar-button'], { 'disabled': !Array.isArray(audioTracks) || audioTracks.length === 0 })} tabIndex={-1} onMouseDown={onAudioButtonMouseDown} onClick={onToggleAudioMenu}>
                        <Icon className={styles['icon']} name={'audio-tracks'} />
                    </Button>
                    {
                        metaItem?.content?.videos?.length > 0 ?
                            <Button className={styles['control-bar-button']} tabIndex={-1} onMouseDown={onVideosButtonMouseDown} onClick={onToggleSideDrawer}>
                                <Icon className={styles['icon']} name={'episodes'} />
                            </Button>
                            :
                            null
                    }
                    <Button className={classnames(styles['control-bar-button'], { 'disabled': videoScale === null })} title={videoScaleLabel} tabIndex={-1} onClick={onVideoScaleChanged}>
                        <Icon className={styles['icon']} name={VIDEO_SCALE_ICONS[videoScale || 'contain']} />
                    </Button>
                    <Button className={classnames(styles['control-bar-button'], { 'disabled': !stream })} tabIndex={-1} onMouseDown={onOptionsButtonMouseDown} onClick={onToggleOptionsMenu}>
                        <Icon className={styles['icon']} name={'more-horizontal'} />
                    </Button>
                </div>
            </div>
        </div>
    );
});

ControlBar.propTypes = {
    className: PropTypes.string,
    paused: PropTypes.bool,
    time: PropTypes.number,
    duration: PropTypes.number,
    buffered: PropTypes.number,
    volume: PropTypes.number,
    muted: PropTypes.bool,
    playbackSpeed: PropTypes.number,
    videoScale: PropTypes.string,
    videoScaleLabel: PropTypes.string,
    live: PropTypes.bool,
    liveTiming: PropTypes.object,
    seekable: PropTypes.bool,
    buffering: PropTypes.bool,
    onVideoScaleChanged: PropTypes.func,
    subtitlesTracks: PropTypes.array,
    audioTracks: PropTypes.array,
    metaItem: PropTypes.object,
    nextVideo: PropTypes.object,
    stream: PropTypes.object,
    statisticsAvailable: PropTypes.bool,
    onPlayRequested: PropTypes.func,
    onPauseRequested: PropTypes.func,
    onNextVideoRequested: PropTypes.func,
    onMuteRequested: PropTypes.func,
    onUnmuteRequested: PropTypes.func,
    onVolumeChangeRequested: PropTypes.func,
    onSeekRequested: PropTypes.func,
    onToggleSubtitlesMenu: PropTypes.func,
    onToggleAudioMenu: PropTypes.func,
    onToggleSpeedMenu: PropTypes.func,
    onToggleSideDrawer: PropTypes.func,
    onToggleOptionsMenu: PropTypes.func,
    onToggleCastDevicesMenu: PropTypes.func,
    onToggleStatisticsMenu: PropTypes.func,
    onMouseOver: PropTypes.func,
    onMouseMove: PropTypes.func,
    onTouchEnd: PropTypes.func,
    remoteMethods: PropTypes.array,
    casting: PropTypes.bool,
};

module.exports = ControlBar;
