// ==UserScript==
// @name             收看SMGTV电视节目
// @namespace        http://tampermonkey.net/
// @version          0.18
// @description      收看SMGTV，并解除页面部分限制（0.18：支持跨日回看锚点捕获，修复五星体育无直播源问题）
// @author           https://github.com/Popukok
// @match            *://*.kankanews.com/huikan*
// @icon             https://live.kankanews.com/favicon.ico
// @updateURL        https://raw.githubusercontent.com/Popukok/smg_live/refs/heads/main/smg_fivestar.user.js
// @downloadURL      https://raw.githubusercontent.com/Popukok/smg_live/refs/heads/main/smg_fivestar.user.js
// @grant            none
// @run-at           document-start
// ==/UserScript==
(function() {
    'use strict';
    const STYLE_ID = 'smgtv-unlock-style';
    const VIDEO_READY_CLASS = 'smgtv-video-ready';
    const FULLSCREEN_FALLBACK_CLASS = 'smgtv-fallback-fullscreen';
    const FULLSCREEN_TARGET_CLASS = 'smgtv-fallback-fullscreen-target';
    const FULLSCREEN_BUTTON_SELECTOR = '.xgplayer-fullscreen';
    const VIDEO_READY_EVENTS = ['loadeddata', 'canplay', 'playing', 'timeupdate', 'progress'];
    const VIDEO_RESET_EVENTS = ['loadstart', 'waiting', 'stalled', 'emptied'];
    const watchedVideos = new WeakSet();
    const streamAddressCache = Object.create(null);
    const channelShiftBaseCache = Object.create(null);
    const channelLiveBaseCache = Object.create(null);
    const LS_KEY_PREFIX = 'smgtv_shift_base_';
    function parseJwtExp(url) {
        try {
            const token = new URL(url).searchParams.get('token');
            if (!token) return null;
            const payload = token.split('.')[1];
            if (!payload) return null;
            const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
            const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
            const json = JSON.parse(atob(padded));
            return typeof json.exp === 'number' ? json.exp * 1000 : null;
        } catch (e) {
            return null;
        }
    }
    function loadPersistedShiftBase(channelId) {
        try {
            const raw = localStorage.getItem(LS_KEY_PREFIX + channelId);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (data && data.url && typeof data.exp === 'number' && Date.now() < data.exp) {
                return { url: data.url, exp: data.exp };
            }
            localStorage.removeItem(LS_KEY_PREFIX + channelId);
        } catch (e) {
            return null;
        }
        return null;
    }
    function savePersistedShiftBase(channelId, url) {
        const exp = parseJwtExp(url);
        if (exp == null) return;
        try {
            localStorage.setItem(LS_KEY_PREFIX + channelId, JSON.stringify({ url: url, exp: exp }));
        } catch (e) {}
    }
    let fullscreenFallbackTarget = null;
    let cssFullscreenFallbackPlayer = null;
    let lastFullscreenActionAt = 0;
    const logThrottle = Object.create(null);
    function throttleLog(key, intervalMs, fn) {
        const now = Date.now();
        if ((logThrottle[key] || 0) + intervalMs > now) {
            return;
        }
        logThrottle[key] = now;
        fn();
    }
    function rememberStreamAddresses(channelId, liveAddress, shiftAddress) {
        if (channelId == null || channelId === '') {
            return;
        }
        const key = String(channelId);
        const prev = streamAddressCache[key] || { live_address: '', shift_address: '' };
        streamAddressCache[key] = {
            live_address: liveAddress || prev.live_address || '',
            shift_address: shiftAddress || prev.shift_address || ''
        };
    }
    function fillStreamAddresses(target, channelId) {
        if (!target) {
            return false;
        }
        const cached = streamAddressCache[String(channelId)] || {};
        const channelLiveAddress = cached.live_address || cached.shift_address;
        const channelShiftAddress = cached.shift_address || cached.live_address;
        if (channelLiveAddress && !target.live_address) {
            target.live_address = channelLiveAddress;
        }
        if (channelShiftAddress && !target.shift_address) {
            target.shift_address = channelShiftAddress;
        }
    }
    function getResultChannelId(result) {
        return result?.channel_id || result?.channel_info?.id || result?.id;
    }
    function forceOpenProgram(program) {
        if (!program) {
            return;
        }
        // 先留存服务端原始值：can_review/is_review 会被下方解锁改写，
        // 但锚点捕获逻辑需要依赖"服务端真实可回看"来判断节目详情是否会签发流地址
        if (program.__smgServerCanReview == null && (program.can_review === 0 || program.can_review === 1)) {
            program.__smgServerCanReview = program.can_review;
        }
        program.is_shield = 0;
        program.can_review = 1;
        program.is_review = 1;
    }
    function forceOpenProgramList(component) {
        if (!component) {
            return;
        }
        ['currentProgramList', 'playingProgramList', 'slitProgramList'].forEach(key => {
            const list = component[key];
            if (!Array.isArray(list)) {
                return;
            }
            list.forEach(program => {
                if (program && (program.is_shield !== 0 || program.can_review !== 1 || program.is_review !== 1)) {
                    forceOpenProgram(program);
                }
            });
        });
        const detailPrograms = component.programDetail?.program_list;
        if (Array.isArray(detailPrograms)) {
            detailPrograms.forEach(program => forceOpenProgram(program));
        }
    }
    function ensurePlayableStream(component) {
        if (!component) {
            return;
        }
        forceOpenProgram(component.programObj);
        const channelDetail = component.currChannelDetail;
        if (channelDetail) {
            rememberStreamAddresses(channelDetail.id, channelDetail.live_address, channelDetail.shift_address);
        }
        const detail = component.programDetail;
        if (!detail) {
            return;
        }
        forceOpenProgram(detail);
        if (detail.is_exist_pad && !(detail.pad_video_info && detail.pad_video_info.play_url)) {
            detail.is_exist_pad = 0;
            detail.pad_src = '';
        }
        const channelInfo = detail.channel_info || (detail.channel_info = {});
        const channelId = getResultChannelId(detail) || channelDetail?.id;
        if (channelDetail) {
            if (channelDetail.live_address) {
                channelInfo.live_address = channelDetail.live_address;
            }
            if (channelDetail.shift_address) {
                channelInfo.shift_address = channelDetail.shift_address;
            }
        }
        fillStreamAddresses(channelInfo, channelId);
    }
    function stripTimeWindow(url) {
        try {
            const u = new URL(url);
            u.searchParams.delete('start');
            u.searchParams.delete('end');
            return u.toString();
        } catch (e) {
            return url
                .replace(/&start=\d+&end=\d+(?=&|$)/g, '')
                .replace(/\?start=\d+&end=\d+(?=&|$)/g, '?')
                .replace(/\?$/, '');
        }
    }
    function installReplayUrlPatch(component) {
        const XGPlayer = component.$xgplayer;
        if (!XGPlayer || component.__smgReplayPatchInstalled) {
            return;
        }
        component.__smgReplayPatchInstalled = true;
        component.$xgplayer = new Proxy(XGPlayer, {
            construct(target, args) {
                const config = args[0] || {};
                const program = component.programObj;
                const channelId = component.currChannel?.id != null ? component.currChannel.id :
                    (component.programDetail?.channel_info?.id != null ? component.programDetail.channel_info.id :
                        program?.channel_id);
                let url = (config.url && typeof config.url === 'string') ? config.url : '';
                const now = Date.now();
                if (channelId != null && /\.m3u8/.test(url)) {
                    const base = stripTimeWindow(url);
                    if (base) {
                        const fromShift = /[?&]start=\d+/.test(url);
                        const store = fromShift ? channelShiftBaseCache : channelLiveBaseCache;
                        const exp = parseJwtExp(url);
                        if (exp != null) {
                            store[channelId] = { url: base, exp: exp };
                        }
                        if (fromShift) {
                            savePersistedShiftBase(channelId, base);
                        }
                        if (fromShift && component.__smgAutoFlashTarget && !component.__smgAutoFlashScheduled) {
                            component.__smgAutoFlashScheduled = true;
                            const flashAnchorId = component.__smgAutoFlashAnchorId;
                            const flashTarget = component.__smgAutoFlashTarget;
                            component.__smgAutoFlashTarget = null;
                            component.__smgAutoFlashAnchorId = null;
                            setTimeout(() => {
                                try {
                                    const stillOnAnchor = component && component.programObj?.id === flashAnchorId;
                                    if (stillOnAnchor && typeof component.changeProgram === 'function' && flashTarget) {
                                        component.changeProgram(flashTarget);
                                    }
                                } catch (e) {
                                    console.warn('[SMGTV] 自动捕获切回失败:', e);
                                } finally {
                                    if (component) {
                                        component.__smgAutoFlashScheduled = false;
                                    }
                                }
                            }, 400);
                        }
                    }
                }
                let baseOk = '';
                if (channelId != null) {
                    if (!(channelShiftBaseCache[channelId] && channelShiftBaseCache[channelId].exp > now)) {
                        const persisted = loadPersistedShiftBase(channelId);
                        if (persisted) {
                            channelShiftBaseCache[channelId] = persisted;
                        }
                    }
                    const shiftEntry = channelShiftBaseCache[channelId];
                    if (shiftEntry && shiftEntry.exp > now) {
                        baseOk = shiftEntry.url;
                    } else {
                        const liveEntry = channelLiveBaseCache[channelId];
                        if (liveEntry && liveEntry.exp > now) {
                            baseOk = liveEntry.url;
                        }
                    }
                }
                const isReplay = config.isLive === false;
                const hasStream = /\.m3u8/.test(url);
                const hasWindow = /\bstart=\d/.test(url);
                if (isReplay && hasWindow) {
                    return new target(...args);
                }
                if (isReplay && hasStream && !hasWindow && program?.start_time && program?.end_time) {
                    config.url = url + (url.includes('?') ? '&' : '?') +
                        'start=' + program.start_time + '&end=' + program.end_time;
                } else if (isReplay && !hasStream && program?.start_time && program?.end_time) {
                    if (baseOk) {
                        config.url = baseOk + '&start=' + program.start_time + '&end=' + program.end_time;
                    } else {
                        component.__smgNeedShiftBase = true;
                    }
                } else if (!isReplay && !hasStream) {
                    if (baseOk) {
                        config.url = baseOk;
                    } else {
                        component.__smgNeedShiftBase = true;
                    }
                }
                return new target(...args);
            }
        });
    }
    function findSportsNewsAnchor(component) {
        const lists = [component?.currentProgramList, component?.playingProgramList, component?.slitProgramList];
        const isEnded = p => p && p.id && p.isOutDate === 0 && p.play === 0;
        const dead = component.__smgDeadAnchors;
        const notDead = p => p && !(dead && dead.has(p.id));
        // 注意：is_review 会被 forceOpenProgram 统一改写为 1，不能再作为"服务端可回看"依据，
        // 这里用改写前留存的服务端原始 can_review（__smgServerCanReview）判断
        const nameMatch = p => notDead(p) && typeof p.name === 'string' && p.name.indexOf('体育新闻') !== -1;
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            for (const p of list) {
                if (isEnded(p) && nameMatch(p) && p.__smgServerCanReview === 1) {
                    return p;
                }
            }
        }
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            // 名称命中即可尝试（个别日期行内未带 can_review 标记，以节目详情返回为准）
            for (const p of list) {
                if (isEnded(p) && nameMatch(p)) {
                    return p;
                }
            }
        }
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            for (const p of list) {
                if (isEnded(p) && notDead(p) && p.__smgServerCanReview === 1) {
                    return p;
                }
            }
        }
        return null;
    }
    function getRestoreProgram(component, anchor) {
        const cur = component?.programObj;
        if (cur && cur.id && (!anchor || cur.id !== anchor.id)) {
            return cur;
        }
        const lists = [component?.currentProgramList, component?.playingProgramList];
        for (const list of lists) {
            if (!Array.isArray(list)) {
                continue;
            }
            const live = list.find(p => p && p.play === 1 && p.id);
            if (live) {
                return live;
            }
        }
        return null;
    }
    const CROSS_DAY_MAX_BACK = 7;
    const CROSS_DAY_RETRY_MS = 60 * 1000;
    function markDeadAnchor(component, anchorId) {
        if (!component || anchorId == null) {
            return;
        }
        if (!component.__smgDeadAnchors) {
            component.__smgDeadAnchors = new Set();
        }
        component.__smgDeadAnchors.add(anchorId);
    }
    function triggerFlashCapture(component, anchor) {
        const restore = getRestoreProgram(component, anchor);
        if (!restore || typeof component.changeProgram !== 'function') {
            // 没有可切回的节目，暂不闪切；记录失败锚点并等待下一次机会
            markDeadAnchor(component, anchor && anchor.id);
            component.__smgNeedShiftBase = true;
            return;
        }
        component.__smgNeedShiftBase = false;
        component.__smgAutoFlashAnchorId = anchor.id;
        component.__smgAutoFlashTarget = restore;
        try {
            component.changeProgram(anchor);
        } catch (e) {
            console.warn('[SMGTV] 兜底捕获触发失败:', e);
            component.__smgAutoFlashTarget = null;
            markDeadAnchor(component, anchor.id);
            component.__smgNeedShiftBase = true;
        }
        setTimeout(() => {
            const canRestore = component && component.__smgAutoFlashTarget &&
                !component.__smgAutoFlashScheduled &&
                component.programObj?.id === component.__smgAutoFlashAnchorId;
            if (canRestore && typeof component.changeProgram === 'function') {
                component.__smgAutoFlashTarget = null;
                component.__smgAutoFlashAnchorId = null;
                // 2500ms 内未能完成捕获（服务端未签发地址 / 无 start 窗口），
                // 拉黑该锚点避免反复横跳，并允许继续寻找其他可用锚点
                markDeadAnchor(component, anchor.id);
                component.__smgNeedShiftBase = true;
                try {
                    component.changeProgram(restore);
                } catch (e) {
                    console.warn('[SMGTV] 兜底捕获切回失败:', e);
                }
            }
        }, 2500);
    }
    function restoreComponentDate(component, originalDate) {
        if (!component || !originalDate || component.activeDate === originalDate) {
            return Promise.resolve();
        }
        try {
            component.activeDate = originalDate;
            if (typeof component.refreshProgramList === 'function') {
                return Promise.resolve(component.refreshProgramList(false)).then(() => undefined);
            }
        } catch (e) {
            console.warn('[SMGTV] 跨日扫描日期还原失败:', e);
        }
        return Promise.resolve();
    }
    function findCrossDayAnchor(component) {
        // 当天节目单尚无"已结束且可回看"的锚点（体育新闻一般在傍晚才播出）时，
        // 依次查看最近几天历史节目单：历史可回看节目现在仍可播放，
        // 服务端照常签发带 token 的时移地址，捕获 base 后即可解锁本频道任意节目/直播。
        if (typeof component.refreshProgramList !== 'function' || !component.activeDate) {
            return Promise.resolve(null);
        }
        const originalDate = component.activeDate;
        const scanChannelId = component.currChannel?.id;
        let offset = 0;
        const attempt = () => {
            if (component.currChannel?.id !== scanChannelId) {
                // 扫描过程中用户切换了频道，放弃本次扫描
                return restoreComponentDate(component, originalDate).then(() => null);
            }
            if (offset >= CROSS_DAY_MAX_BACK) {
                return restoreComponentDate(component, originalDate).then(() => null);
            }
            offset += 1;
            const d = new Date();
            d.setDate(d.getDate() - offset);
            const pad = n => String(n).padStart(2, '0');
            const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
            try {
                component.activeDate = { dateStr: dateStr };
            } catch (e) {
                return restoreComponentDate(component, originalDate).then(() => null);
            }
            return Promise.resolve(component.refreshProgramList(false))
                .then(() => new Promise(r => setTimeout(r, 350)))
                .then(() => {
                    const anchor = findSportsNewsAnchor(component);
                    if (anchor) {
                        const copy = Object.assign({}, anchor, {
                            is_shield: 0,
                            can_review: 1,
                            is_review: 1,
                            isOutDate: 0
                        });
                        return restoreComponentDate(component, originalDate).then(() => copy);
                    }
                    return attempt();
                })
                .catch(() => attempt());
        };
        return attempt().then(found => {
            if (component && component.currentProgramList && component.currentProgramList.length === 0 &&
                typeof component.refreshProgramList === 'function') {
                restoreComponentDate(component, originalDate);
            }
            return found;
        });
    }
    function maybeAutoCaptureShift(component, fromMonitor) {
        if (!component || !component.__smgPatched || !component.__smgNeedShiftBase || !fromMonitor) {
            return;
        }
        const chId = component.currChannel?.id;
        if (chId == null) {
            return;
        }
        const now = Date.now();
        if (!(channelShiftBaseCache[chId] && channelShiftBaseCache[chId].exp > now)) {
            const persisted = loadPersistedShiftBase(chId);
            if (persisted) {
                channelShiftBaseCache[chId] = persisted;
            }
        }
        const hasBase = !!(channelShiftBaseCache[chId] && channelShiftBaseCache[chId].exp > now) ||
            !!(channelLiveBaseCache[chId] && channelLiveBaseCache[chId].exp > now);
        if (hasBase) {
            component.__smgNeedShiftBase = false;
            if (component.__smgDeadAnchors) {
                component.__smgDeadAnchors.clear();
            }
            return;
        }
        if (String(chId) !== '10') {
            component.__smgNeedShiftBase = false;
            return;
        }
        const anchor = findSportsNewsAnchor(component);
        if (anchor) {
            triggerFlashCapture(component, anchor);
            return;
        }
        // 当天无可用锚点：启动跨日历史节目单扫描（节流 + 防重入），成功后再做闪切捕获
        if (!component.__smgCrossDayScanning && !component.__smgAutoFlashScheduled) {
            const lastTry = component.__smgCrossDayScanAt || 0;
            if (now - lastTry >= CROSS_DAY_RETRY_MS) {
                component.__smgCrossDayScanAt = now;
                component.__smgCrossDayScanning = true;
                component.__smgNeedShiftBase = false;
                findCrossDayAnchor(component).then(found => {
                    component.__smgCrossDayScanning = false;
                    if (found && component.currChannel && String(component.currChannel.id) === '10') {
                        triggerFlashCapture(component, found);
                    }
                }).catch(() => {
                    component.__smgCrossDayScanning = false;
                });
            }
        }
        component.__smgNeedShiftBase = false;
    }
    function recoverPlayerIfNeeded(component) {
        if (!component || typeof component.initPlayer !== 'function' || component.__smgRecovering) {
            return;
        }
        const video = getPlayerVideo(component);
        const mediaError = video?.error;
        if (!(component.player && mediaError && mediaError.code === 4)) {
            return;
        }
        ensurePlayableStream(component);
        const hasLive = !!(component.programDetail?.channel_info?.live_address ||
            component.currChannelDetail?.live_address);
        if (!hasLive) {
            if (component.__smgNeedShiftBase) {
                component.__smgRecovering = true;
                maybeAutoCaptureShift(component, true);
                setTimeout(() => {
                    component.__smgRecovering = false;
                }, 2000);
            }
            return;
        }
        component.__smgRecoverCount = (component.__smgRecoverCount || 0) + 1;
        if (component.__smgRecoverCount > 3) {
            return;
        }
        component.__smgRecovering = true;
        component.initPlayer({ changeCurrentList: false, isPlay: true, trigger: 'click' });
        setTimeout(() => {
            component.__smgRecovering = false;
        }, 2000);
    }
    function injectStyle(cssText) {
        const appendStyle = () => {
            if (document.getElementById(STYLE_ID)) {
                return;
            }
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = cssText;
            (document.head || document.documentElement).appendChild(style);
        };
        if (document.head || document.documentElement) {
            appendStyle();
        } else {
            document.addEventListener('DOMContentLoaded', appendStyle, { once: true });
        }
    }
    function ensureViewportFitCover() {
        const apply = () => {
            try {
                const meta = document.querySelector('meta[name="viewport"]');
                if (meta) {
                    const content = meta.getAttribute('content') || '';
                    if (!/viewport-fit\s*=\s*cover/i.test(content)) {
                        meta.setAttribute('content', content ? content + ', viewport-fit=cover' : 'viewport-fit=cover');
                    }
                    return;
                }
                const created = document.createElement('meta');
                created.setAttribute('name', 'viewport');
                created.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
                (document.head || document.documentElement).appendChild(created);
            } catch (e) {
                throttleLog('viewport-error', 5000, () => console.warn('[SMGTV] 设置 viewport-fit 失败:', e));
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', apply, { once: true });
        } else {
            apply();
        }
    }
    function getVueInstance(el) {
        return el?.__vue__ || el?.__vueParentComponent?.proxy || null;
    }
    function isTVComponent(instance) {
        return !!instance && (
            typeof instance.initPlayer === 'function' ||
            typeof instance.playProgram === 'function' ||
            typeof instance.setLiveTimer === 'function' ||
            ('isLoading' in instance && 'player' in instance)
        );
    }
    function findComponentFromElement(el) {
        let current = el;
        while (current) {
            const instance = getVueInstance(current);
            if (isTVComponent(instance)) {
                return instance;
            }
            current = current.parentElement;
        }
        return null;
    }
    function findTVComponent() {
        const selectors = ['.huikan', '.live-container', '.live-box', '.live-player', '.tv', '.player-box'];
        for (const selector of selectors) {
            const component = findComponentFromElement(document.querySelector(selector));
            if (component) {
                return component;
            }
        }
        return null;
    }
    function getPlayerVideo(component) {
        const player = component?.player;
        return player?.video ||
            player?.media ||
            player?.root?.querySelector?.('video') ||
            component?.$refs?.livePlayer?.querySelector?.('video') ||
            document.querySelector('.live-player video, .player-box video, .xgplayer video, video');
    }
    function isVideoReady(video) {
        return !!video && !video.error && (
            video.readyState >= 2 ||
            (!video.paused && video.currentTime > 0)
        );
    }
    function setVideoReadyClass(isReady) {
        const target = document.body || document.documentElement;
        target?.classList?.toggle(VIDEO_READY_CLASS, isReady);
    }
    function syncLoadingState(component) {
        forceOpenProgramList(component);
        maybeAutoCaptureShift(component, false);
        recoverPlayerIfNeeded(component);
        const video = getPlayerVideo(component);
        if (video) {
            watchPlayerVideo(component, video);
        }
        const isReady = isVideoReady(video);
        setVideoReadyClass(isReady);
        if (isReady && component && component.isLoading) {
            component.isLoading = false;
        }
        return isReady;
    }
    function watchPlayerVideo(component, video) {
        if (!video || watchedVideos.has(video)) {
            return;
        }
        watchedVideos.add(video);
        const markReady = () => syncLoadingState(component);
        const resetReady = () => {
            if (!isVideoReady(video)) {
                setVideoReadyClass(false);
            }
        };
        VIDEO_READY_EVENTS.forEach(eventName => {
            video.addEventListener(eventName, markReady, { passive: true });
        });
        VIDEO_RESET_EVENTS.forEach(eventName => {
            video.addEventListener(eventName, resetReady, { passive: true });
        });
        video.addEventListener('webkitbeginfullscreen', () => syncFullscreenButtonState(component, true), { passive: true });
        video.addEventListener('webkitendfullscreen', () => syncFullscreenButtonState(component, false), { passive: true });
        markReady();
    }
    function cleanupComponent(component) {
        if (!component) {
            return;
        }
        if (component.__smgLoadingMonitor) {
            clearInterval(component.__smgLoadingMonitor);
            component.__smgLoadingMonitor = null;
        }
        if (component.__smgLoadingObserver) {
            component.__smgLoadingObserver.disconnect();
            component.__smgLoadingObserver = null;
        }
        if (component.pageVisibilityChange) {
            document.removeEventListener('visibilitychange', component.pageVisibilityChange);
        }
    }
    function startLoadingMonitor(component) {
        if (!component || component.__smgLoadingMonitor) {
            return;
        }
        component.__smgLoadingMonitor = setInterval(() => {
            const rootEl = component.$el;
            if (rootEl && !rootEl.isConnected) {
                cleanupComponent(component);
                initComponentPatch();
                return;
            }
            maybeAutoCaptureShift(component, true);
            syncLoadingState(component);
        }, 500);
        if (component.$refs?.livePlayer && !component.__smgLoadingObserver) {
            component.__smgLoadingObserver = new MutationObserver(() => syncLoadingState(component));
            component.__smgLoadingObserver.observe(component.$refs.livePlayer, {
                childList: true,
                subtree: true
            });
        }
    }
    function getBrowserFullscreenElement() {
        return document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            null;
    }
    function requestElementFullscreen(el) {
        if (!el) {
            return Promise.reject(new Error('missing fullscreen target'));
        }
        const request =
            el.requestFullscreen ||
            el.webkitRequestFullscreen ||
            el.webkitRequestFullScreen ||
            el.mozRequestFullScreen ||
            el.msRequestFullscreen;
        if (!request) {
            return Promise.reject(new Error('fullscreen api unavailable'));
        }
        try {
            const result = request.call(el);
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function exitBrowserFullscreen() {
        const exit =
            document.exitFullscreen ||
            document.webkitExitFullscreen ||
            document.webkitCancelFullScreen ||
            document.mozCancelFullScreen ||
            document.msExitFullscreen;
        if (!exit) {
            return Promise.resolve();
        }
        try {
            const result = exit.call(document);
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function getFullscreenTarget(component, button) {
        return component?.player?.root ||
            button?.closest?.('.xgplayer') ||
            component?.$refs?.livePlayer?.querySelector?.('.xgplayer') ||
            component?.$refs?.livePlayer ||
            document.querySelector('.live-player .xgplayer, .player-box .xgplayer, .xgplayer, .live-player, .player-box');
    }
    function syncFullscreenButtonState(component, isFullscreen) {
        document.querySelectorAll(FULLSCREEN_BUTTON_SELECTOR).forEach(button => {
            button.setAttribute('data-state', isFullscreen ? 'full' : 'normal');
        });
    }
    function enterFallbackFullscreen(target, component) {
        if (!target) {
            return;
        }
        const player = component?.player;
        if (player && typeof player.getCssFullscreen === 'function') {
            try {
                player.getCssFullscreen(target);
                cssFullscreenFallbackPlayer = player;
                syncFullscreenButtonState(component, true);
                return;
            } catch (e) {
                console.warn('[SMGTV] xgplayer CSS 全屏失败，使用样式兜底', e);
            }
        }
        exitFallbackFullscreen(component);
        fullscreenFallbackTarget = target;
        target.classList.add(FULLSCREEN_TARGET_CLASS);
        document.body?.classList.add(FULLSCREEN_FALLBACK_CLASS);
        syncFullscreenButtonState(component, true);
    }
    function exitFallbackFullscreen(component) {
        const player = component?.player || cssFullscreenFallbackPlayer;
        if (cssFullscreenFallbackPlayer && player && typeof player.exitCssFullscreen === 'function') {
            try {
                player.exitCssFullscreen();
            } catch (e) {
                console.warn('[SMGTV] 退出 xgplayer CSS 全屏失败', e);
            }
        }
        cssFullscreenFallbackPlayer = null;
        if (fullscreenFallbackTarget) {
            fullscreenFallbackTarget.classList.remove(FULLSCREEN_TARGET_CLASS);
            fullscreenFallbackTarget = null;
        }
        document.body?.classList.remove(FULLSCREEN_FALLBACK_CLASS);
        syncFullscreenButtonState(component, false);
    }
    function isFallbackFullscreen() {
        return !!document.body?.classList.contains(FULLSCREEN_FALLBACK_CLASS) ||
            !!cssFullscreenFallbackPlayer?.cssfullscreen ||
            !!cssFullscreenFallbackPlayer?.isCssfullScreen;
    }
    function callFullscreenMethod(fn) {
        try {
            const result = fn();
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function enterNativeVideoFullscreen(component) {
        const video = getPlayerVideo(component);
        if (!video || typeof video.webkitEnterFullscreen !== 'function') {
            return false;
        }
        try {
            video.webkitEnterFullscreen();
            syncFullscreenButtonState(component, true);
            return true;
        } catch (e) {
            console.warn('[SMGTV] iOS 原生视频全屏失败，使用 CSS 兜底', e);
            return false;
        }
    }
    function enterFullscreen(component, target) {
        const player = component?.player;
        const enterNative = callFullscreenMethod(() => (
            player && typeof player.getFullscreen === 'function' ?
                player.getFullscreen(target) :
                requestElementFullscreen(target)
        ));
        Promise.resolve(enterNative)
            .then(() => syncFullscreenButtonState(component, true))
            .catch(() => {
                if (!enterNativeVideoFullscreen(component)) {
                    enterFallbackFullscreen(target, component);
                }
            });
    }
    function exitFullscreen(component) {
        const player = component?.player;
        if (isFallbackFullscreen()) {
            exitFallbackFullscreen(component);
            return;
        }
        const exitNative = callFullscreenMethod(() => (
            player && typeof player.exitFullscreen === 'function' ?
                player.exitFullscreen() :
                exitBrowserFullscreen()
        ));
        Promise.resolve(exitNative)
            .catch(exitBrowserFullscreen)
            .then(
                () => syncFullscreenButtonState(component, false),
                () => syncFullscreenButtonState(component, false)
            );
    }
    function handleFullscreenControl(event) {
        const button = event.target?.closest?.(FULLSCREEN_BUTTON_SELECTOR);
        if (!button) {
            return;
        }
        const now = Date.now();
        if (now - lastFullscreenActionAt < 300) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        lastFullscreenActionAt = now;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const component = findTVComponent();
        const target = getFullscreenTarget(component, button);
        syncLoadingState(component);
        const video = getPlayerVideo(component);
        if (getBrowserFullscreenElement() || isFallbackFullscreen()) {
            exitFullscreen(component);
        } else if (video && video.webkitDisplayingFullscreen) {
            try {
                if (typeof video.webkitExitFullscreen === 'function') {
                    video.webkitExitFullscreen();
                }
            } catch (e) {
                console.warn('[SMGTV] 退出 iOS 原生全屏失败', e);
            }
            syncFullscreenButtonState(component, false);
        } else {
            enterFullscreen(component, target);
        }
    }
    function handleFullscreenChange() {
        if (getBrowserFullscreenElement()) {
            if (isFallbackFullscreen()) {
                exitFallbackFullscreen(findTVComponent());
            }
            syncFullscreenButtonState(findTVComponent(), true);
        } else if (!isFallbackFullscreen()) {
            syncFullscreenButtonState(findTVComponent(), false);
        }
    }
    function initFullscreenPatch() {
        document.addEventListener('click', handleFullscreenControl, true);
        document.addEventListener('touchend', handleFullscreenControl, true);
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        document.addEventListener('MSFullscreenChange', handleFullscreenChange);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && isFallbackFullscreen()) {
                exitFallbackFullscreen(findTVComponent());
            }
        });
    }
    function wrapComponentMethod(component, methodName, after) {
        const original = component?.[methodName];
        if (typeof original !== 'function' || original.__smgWrapped) {
            return;
        }
        const wrapped = function() {
            const programId = this.programObj?.id;
            if (programId && programId !== this.__smgRecoverProgramId) {
                this.__smgRecoverProgramId = programId;
                this.__smgRecoverCount = 0;
            }
            ensurePlayableStream(this);
            const result = original.apply(this, arguments);
            const runAfter = () => {
                ensurePlayableStream(this);
                setTimeout(() => after(this), 0);
                setTimeout(() => after(this), 250);
                setTimeout(() => after(this), 1000);
            };
            if (result && typeof result.then === 'function') {
                result.then(runAfter, runAfter);
            } else {
                runAfter();
            }
            return result;
        };
        wrapped.__smgWrapped = true;
        wrapped.__smgOriginal = original;
        component[methodName] = wrapped;
    }
    function patchComponent(component) {
        if (!component) {
            return;
        }
        startLoadingMonitor(component);
        if (component.__smgPatched) {
            syncLoadingState(component);
            return;
        }
        component.__smgPatched = true;
        if (typeof component.countdown === 'number') {
            component.countdown = 99999999;
        }
        component.showOpenApp = false;
        component.showFlag = false;
        component.startCountdown = function() {};
        if (component.liveTimer) {
            clearTimeout(component.liveTimer);
            component.liveTimer = null;
        }
        if (!component.player && component.programObj?.id && typeof component.playProgram === 'function') {
            component.playProgram();
        }
        if (typeof component.pageVisibilityChange === 'function') {
            document.removeEventListener('visibilitychange', component.pageVisibilityChange);
            component.pageVisibilityChange = function() {};
            document.addEventListener('visibilitychange', component.pageVisibilityChange);
        }
        if (component._handlerUnload) {
            window.removeEventListener('unload', component._handlerUnload);
            component._handlerUnload = null;
        }
        ['initPlayer', 'initNoProgramPlayer', 'initPadPlayer', 'changeProgram', 'changeChannel', 'getProgramDetail'].forEach(methodName => {
            wrapComponentMethod(component, methodName, syncLoadingState);
        });
        installReplayUrlPatch(component);
        ensurePlayableStream(component);
        const handleProgramList = component.handleProgramList;
        if (typeof handleProgramList === 'function' && !handleProgramList.__smgWrapped) {
            const wrappedList = function(...args) {
                const result = handleProgramList.apply(this, args);
                if (Array.isArray(result)) {
                    result.forEach(program => forceOpenProgram(program));
                }
                return result;
            };
            wrappedList.__smgWrapped = true;
            component.handleProgramList = wrappedList;
        }
        forceOpenProgramList(component);
        syncLoadingState(component);
        if (component.player && !component.player.config?.isPad && component.programObj?.play === 0) {
            const playerUrl = component.player?.config?.url || '';
            if (!/\bstart=\d/.test(playerUrl)) {
                component.initPlayer({ changeCurrentList: false, isPlay: true, trigger: 'auto' });
            }
        }
    }
    let scanning = false;
    function initComponentPatch() {
        if (scanning) {
            return;
        }
        scanning = true;
        let attempts = 0;
        const maxAttempts = 50;
        const timer = setInterval(() => {
            const component = findTVComponent();
            if (component) {
                clearInterval(timer);
                scanning = false;
                patchComponent(component);
                return;
            }
            attempts += 1;
            if (attempts >= maxAttempts) {
                clearInterval(timer);
                scanning = false;
                console.warn('[SMGTV] 未找到播放器组件实例');
            }
        }, 200);
    }
    injectStyle(`
    .video-tip {
        display: none !important;
    }
    body.${VIDEO_READY_CLASS} .loading-mask {
        display: none !important;
        pointer-events: none !important;
    }
    body.${FULLSCREEN_FALLBACK_CLASS} {
        overflow: hidden !important;
    }
    .${FULLSCREEN_TARGET_CLASS} {
        background: #000 !important;
        bottom: 0 !important;
        box-sizing: border-box !important;
        height: 100vh !important;
        height: 100dvh !important;
        inset: 0 !important;
        left: 0 !important;
        margin: 0 !important;
        max-height: none !important;
        max-width: none !important;
        min-height: 100vh !important;
        min-height: 100dvh !important;
        min-width: 100vw !important;
        min-width: 100dvw !important;
        padding: 0 !important;
        position: fixed !important;
        right: 0 !important;
        top: 0 !important;
        transform: none !important;
        width: 100vw !important;
        width: 100dvw !important;
        z-index: 2147483647 !important;
    }
    .${FULLSCREEN_TARGET_CLASS}.xgplayer,
    .${FULLSCREEN_TARGET_CLASS} .xgplayer {
        height: 100% !important;
        inset: 0 !important;
        margin: 0 !important;
        max-height: none !important;
        max-width: none !important;
        padding: 0 !important;
        padding-top: 0 !important;
        position: absolute !important;
        transform: none !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-screen-container,
    .${FULLSCREEN_TARGET_CLASS} xg-video-container.xg-video-container,
    .${FULLSCREEN_TARGET_CLASS} .xg-video-container {
        bottom: 0 !important;
        display: block !important;
        height: 100% !important;
        inset: 0 !important;
        position: absolute !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} video,
    .${FULLSCREEN_TARGET_CLASS} canvas,
    .${FULLSCREEN_TARGET_CLASS} live-video {
        bottom: 0 !important;
        height: 100% !important;
        left: 0 !important;
        max-height: none !important;
        max-width: none !important;
        object-fit: contain !important;
        position: absolute !important;
        right: 0 !important;
        top: 0 !important;
        transform: none !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-controls,
    .${FULLSCREEN_TARGET_CLASS} .xg-top-bar {
        z-index: 2147483647 !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-controls {
        padding-bottom: env(safe-area-inset-bottom, 0px) !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xg-top-bar {
        padding-top: env(safe-area-inset-top, 0px) !important;
    }
    `);
    const originalOpen = XMLHttpRequest.prototype.open;
    function isTargetTVApi(url) {
        try {
            return new URL(String(url), location.href).pathname.includes('/content/pc/tv/');
        } catch (e) {
            return String(url).includes('/content/pc/tv/');
        }
    }
    function rewriteTvApiResponse(requestUrl, response) {
        let modified = false;
        if (!response || typeof response !== 'object') {
            return false;
        }
        if (requestUrl.includes('/channel/detail') && response.result) {
            rememberStreamAddresses(
                response.result.id,
                response.result.live_address,
                response.result.shift_address
            );
        }
        if (requestUrl.includes('/program/detail') && response.result) {
            forceOpenProgram(response.result);
            const channelInfo = response.result.channel_info || (response.result.channel_info = {});
            forceOpenProgram(channelInfo);
            const channelId = getResultChannelId(response.result);
            fillStreamAddresses(channelInfo, channelId);
            modified = true;
        }
        if (requestUrl.includes('/programs') && response.result?.programs) {
            response.result.programs.forEach(program => {
                forceOpenProgram(program);
                modified = true;
            });
        }
        return modified;
    }
    function replaceXhrResponse(xhr, body) {
        try {
            Object.defineProperty(xhr, 'responseText', {
                value: body,
                writable: false,
                configurable: true
            });
            Object.defineProperty(xhr, 'response', {
                value: xhr.responseType === 'json' ? JSON.parse(body) : body,
                writable: false,
                configurable: true
            });
        } catch (e) {
            throttleLog('rewrite-error', 5000, () => console.error('[SMGTV] 重写接口响应失败:', e));
        }
    }
    XMLHttpRequest.prototype.open = function(method, url) {
        this.__smgRequestUrl = String(url);
        if (isTargetTVApi(this.__smgRequestUrl)) {
            if (!this.__smgHooked) {
                this.__smgHooked = true;
                this.addEventListener('readystatechange', function() {
                    if (this.readyState !== 4) {
                        return;
                    }
                    const requestUrl = this.__smgRequestUrl;
                    try {
                        let response;
                        let rawText = null;
                        try {
                            rawText = this.responseText;
                        } catch (e) {
                            rawText = null;
                        }
                        if (typeof rawText === 'string' && rawText) {
                            response = JSON.parse(rawText);
                        } else if (this.response && typeof this.response === 'object') {
                            response = this.response;
                        } else {
                            return;
                        }
                        if (rewriteTvApiResponse(requestUrl, response)) {
                            replaceXhrResponse(this, JSON.stringify(response));
                        }
                    } catch (e) {
                        throttleLog('parse-error', 5000, () => console.error('[SMGTV] 解析接口响应失败:', e));
                    }
                });
            }
        }
        return originalOpen.apply(this, arguments);
    };
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
        window.fetch = function(input, init) {
            const requestUrl = String(typeof input === 'string' ? input : (input && input.url) || '');
            const request = originalFetch.apply(this, arguments);
            if (!isTargetTVApi(requestUrl)) {
                return request;
            }
            return request.then(res => {
                if (!res) {
                    return res;
                }
                try {
                    return res.clone().text().then(raw => {
                        try {
                            const response = JSON.parse(raw);
                            if (!rewriteTvApiResponse(requestUrl, response)) {
                                return res;
                            }
                            return new Response(JSON.stringify(response), {
                                status: res.status,
                                statusText: res.statusText,
                                headers: res.headers
                            });
                        } catch (e) {
                            throttleLog('parse-error', 5000, () => console.error('[SMGTV] 解析接口响应失败:', e));
                            return res;
                        }
                    }).catch(() => res);
                } catch (e) {
                    throttleLog('rewrite-error', 5000, () => console.error('[SMGTV] 重写接口响应失败:', e));
                    return res;
                }
            });
        };
    }
    ensureViewportFitCover();
    initComponentPatch();
    initFullscreenPatch();
})();
