// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// CrazyGames SDK v3 emulator: logs every call and property read; a member it lacks is logged as missing.
(function () {
  const cg = window.__cg;
  const rec = cg ? cg.rec : () => {};
  const cfg = Object.assign(
    {
      adOutcome: 'finished',
      // Ad timings are not measured on the portal; they only need to be short and ordered.
      adStartMs: 300,
      adDurationMs: 1500,
      // The game gets this long after adStarted to go quiet before the level is sampled.
      adSilenceAfterMs: 300,
      accountAvailable: true,
      user: null,
      locale: 'en-US',
      initialData: {},
    },
    cg ? cg.cfg.sdk : {},
  );
  const data = new Map(Object.entries(cfg.initialData));
  const authListeners = new Set();
  const settingsListeners = new Set();
  const settings = { muteAudio: false, disableChat: false };
  const later = (ms, fn) => setTimeout(fn, ms);

  const SDK = {
    environment: 'crazygames',
    isQaTool: false,
    init: () => new Promise((resolve) => later(30, resolve)),
    game: {
      settings,
      isInstantMultiplayer: false,
      gameplayStart: () => {},
      gameplayStop: () => {},
      loadingStart: () => {},
      loadingStop: () => {},
      happytime: () => {},
      addSettingsChangeListener: (cb) => settingsListeners.add(cb),
      removeSettingsChangeListener: (cb) => settingsListeners.delete(cb),
      inviteLink: (params) => 'https://www.crazygames.com/game/x?' + new URLSearchParams(params || {}).toString(),
      showInviteButton: (params) => 'https://www.crazygames.com/game/x?' + new URLSearchParams(params || {}).toString(),
      hideInviteButton: () => {},
      getInviteParam: (name) => new URLSearchParams(location.search).get(name),
    },
    ad: {
      hasAdblock: () => Promise.resolve(false),
      requestAd: (type, callbacks) =>
        new Promise((resolve) => {
          const cb = callbacks || {};
          if (cfg.adOutcome !== 'finished') {
            later(cfg.adStartMs, () => {
              rec('ad.adError', 'event', [type, cfg.adOutcome]);
              cb.adError && cb.adError({ code: cfg.adOutcome, message: cfg.adOutcome });
              resolve();
            });
            return;
          }
          // The level before the ad is the baseline: a game silent by then has nothing to mute.
          const before = cg ? cg.sampleAudio('ad.before', cfg.adStartMs - 50) : Promise.resolve(null);
          before.then(() => later(50, () => {
            rec('ad.adStarted', 'event', [type]);
            cb.adStarted && cb.adStarted();
            later(cfg.adSilenceAfterMs, () => {
              if (cg) {
                cg.sampleAudio('ad.audio', 250);
              }
            });
            later(cfg.adDurationMs, () => {
              rec('ad.adFinished', 'event', [type]);
              cb.adFinished && cb.adFinished();
              resolve();
            });
          }));
        }),
    },
    banner: {
      requestBanner: () => Promise.resolve(),
      requestResponsiveBanner: () => Promise.resolve(),
      clearBanner: () => {},
      clearAllBanners: () => {},
    },
    user: {
      isUserAccountAvailable: cfg.accountAvailable,
      systemInfo: {
        countryCode: 'US',
        locale: cfg.locale,
        device: { type: 'desktop' },
        os: { name: 'Windows', version: '11' },
        browser: { name: 'Chrome', version: '140' },
        applicationType: 'web',
      },
      getUser: () => Promise.resolve(cfg.user),
      getUserToken: () => Promise.reject(Object.assign(new Error('no user'), { code: 'userNotAuthenticated' })),
      getXsollaUserToken: () => Promise.reject(Object.assign(new Error('no user'), { code: 'userNotAuthenticated' })),
      showAuthPrompt: () => Promise.reject(Object.assign(new Error('cancelled'), { code: 'userCancelled' })),
      showAccountLinkPrompt: () => Promise.resolve({ response: 'no' }),
      addAuthListener: (cb) => authListeners.add(cb),
      removeAuthListener: (cb) => authListeners.delete(cb),
    },
    data: {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => {
        data.set(key, String(value));
      },
      removeItem: (key) => {
        data.delete(key);
      },
      clear: () => data.clear(),
    },
    analytics: {
      trackOrder: () => {},
    },
  };

  // Promise machinery, devtools and frameworks probe these; they are not SDK usage.
  const QUIET = new Set(['then', 'toJSON', 'constructor', 'prototype', 'asymmetricMatch', 'nodeType', 'tagName', 'length']);
  const short = (args) => args.map((a) => (typeof a === 'string' ? a.slice(0, 40) : typeof a === 'function' ? 'fn' : a && typeof a === 'object' ? (typeof a.id === 'string' ? '#' + a.id : 'obj') : a));
  const MODULES = new Set(['game', 'ad', 'banner', 'user', 'data', 'analytics']);

  const wrap = (target, path) => {
    // Keyed by the function itself: a game that replaces a method later gets its replacement logged.
    const wrappers = new WeakMap();
    return new Proxy(target, {
      get(obj, key) {
        if (typeof key === 'symbol' || QUIET.has(key)) {
          return obj[key];
        }
        const name = path + key;
        if (!(key in obj)) {
          rec(name, 'missing');
          return undefined;
        }
        const value = obj[key];
        if (path === '' && MODULES.has(key)) {
          return modules[key];
        }
        if (typeof value === 'function') {
          if (!wrappers.has(value)) {
            wrappers.set(value, function (...args) {
              rec(name, 'call', short(args));
              return value.apply(obj, args);
            });
          }
          return wrappers.get(value);
        }
        rec(name, 'read');
        return value;
      },
    });
  };
  const modules = {};
  for (const key of MODULES) {
    modules[key] = wrap(SDK[key], key + '.');
  }
  if (cg) {
    cg.data = data;
  }
  window.CrazyGames = { SDK: wrap(SDK, '') };
})();
