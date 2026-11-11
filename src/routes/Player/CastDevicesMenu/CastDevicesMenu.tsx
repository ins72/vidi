// Copyright (C) 2017-2026 Smart code 203358507

import React, { forwardRef, memo, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import Option from '../OptionsMenu/Option';
import styles from './styles.less';

type CastDevice = {
    id: string,
    name: string,
};

type CastMethod = {
    id: string,
    label: string,
    start: () => void,
};

type Props = {
    className: string,
    devices: CastDevice[],
    loading: boolean,
    methods?: CastMethod[],
    onDeviceSelected?: (deviceId: string) => void,
};

const CastDevicesMenu = memo(forwardRef<HTMLDivElement, Props>(({ className, devices, loading, methods, onDeviceSelected }, ref) => {
    const { t } = useTranslation();

    const onMouseDown = React.useCallback((event: MouseEvent) => {
        // @ts-expect-error: Property 'castDevicesMenuClosePrevented' does not exist on type 'MouseEvent'.
        event.nativeEvent.castDevicesMenuClosePrevented = true;
    }, []);

    const hasMethods = Array.isArray(methods) && methods.length > 0;
    const hasDevices = Array.isArray(devices) && devices.length > 0;

    return (
        <div ref={ref} className={classNames(className, styles['cast-devices-menu-container'])} onMouseDown={onMouseDown}>
            {
                hasMethods || hasDevices ?
                    <>
                        {
                            hasMethods ?
                                methods.map(({ id, label, start }) => (
                                    <Option
                                        key={`method-${id}`}
                                        icon={'cast'}
                                        label={t(label) !== label ? t(label) : (t(`PLAYER_CAST_${id.toUpperCase()}`, { defaultValue: label }) || label)}
                                        deviceId={id}
                                        onClick={() => { try { if (typeof start === 'function') start(); } catch (_e) { void _e; } }}
                                    />
                                ))
                                :
                                null
                        }
                        {
                            hasDevices ?
                                devices.map(({ id, name }) => (
                                    <Option
                                        key={`device-${id}`}
                                        icon={'cast'}
                                        label={t('PLAYER_PLAY_IN', { device: name })}
                                        deviceId={id}
                                        onClick={() => { try { if (typeof onDeviceSelected === 'function') onDeviceSelected(id); } catch (_e) { void _e; } }}
                                    />
                                ))
                                :
                                null
                        }
                    </>
                    :
                    <div className={styles['message']}>
                        {
                            loading ?
                                t('STREAM_LOADING')
                                :
                                <>
                                    <div className={styles['title']}>{t('PLAYER_CAST_NO_METHODS_TITLE', { defaultValue: 'No remote playback available' })}</div>
                                    <div>{t('PLAYER_CAST_HELP', { defaultValue: 'AirPlay: swipe into Control Center and use Screen Mirroring. Chromecast: open this page in Chrome on Android or desktop.' })}</div>
                                </>
                        }
                    </div>
            }
        </div>
    );
}));

export default CastDevicesMenu;
