// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Runs in the game frame before its scripts: localStorage writes, windows, errors and the audio level.
(function () {
  if (window.__cg || location.hostname !== 'games.crazygames.com') {
    return;
  }
  const cfg = window.__cgCfg || {};
  const log = [];
  const rec = (n, k, a) => {
    log.push({ n, k, t: Math.round(performance.now()), a });
  };
  const cg = { log, rec, cfg, contexts: [], media: new Set(), routed: new WeakSet() };
  window.__cg = cg;

  window.addEventListener('error', (e) => rec('page.error', 'error', [String(e.message).slice(0, 160)]));
  window.addEventListener('unhandledrejection', (e) => rec('page.error', 'error', [String(e.reason && e.reason.message ? e.reason.message : e.reason).slice(0, 160)]));

  const nativeSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    try {
      if (this === window.localStorage) {
        rec('localStorage.setItem', 'call', [String(key).slice(0, 40)]);
      }
    } catch (e) {
      // Storage access can throw in a sandboxed frame; the write itself decides what happens.
    }
    return nativeSetItem.call(this, key, value);
  };

  const Native = window.AudioContext || window.webkitAudioContext;
  if (Native) {
    const destination = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination').get;
    // Tapped in front of destination, so the level is measured for any engine.
    class Tapped extends Native {
      constructor(...args) {
        super(...args);
        const analyser = this.createAnalyser();
        analyser.fftSize = 2048;
        const tap = this.createGain();
        tap.connect(analyser);
        analyser.connect(destination.call(this));
        Object.defineProperty(this, 'destination', { get: () => tap });
        cg.contexts.push({ ctx: this, analyser });
      }
      // A media element routed into the graph is heard through the analyser, not on its own.
      createMediaElementSource(el) {
        cg.routed.add(el);
        return super.createMediaElementSource(el);
      }
    }
    window.AudioContext = Tapped;
    if (window.webkitAudioContext) {
      window.webkitAudioContext = Tapped;
    }
  }
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    cg.media.add(this);
    return nativePlay.apply(this, args);
  };

  // Peak RMS over the running contexts plus media elements that are actually audible.
  cg.audio = () => {
    let rms = 0;
    let running = 0;
    const buf = new Float32Array(2048);
    for (const { ctx, analyser } of cg.contexts) {
      if (ctx.state !== 'running') {
        continue;
      }
      running++;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        sum += v * v;
      }
      rms = Math.max(rms, Math.sqrt(sum / buf.length));
    }
    let media = 0;
    for (const el of cg.media) {
      if (!cg.routed.has(el) && !el.paused && !el.muted && el.volume > 0) {
        media++;
      }
    }
    return { rms: Math.round(rms * 10000) / 10000, running, media };
  };
  // Several samples, as one buffer can fall into a gap; the last field is how far the audio clock moved.
  const audioClock = () => cg.contexts.reduce((max, { ctx }) => Math.max(max, ctx.currentTime), 0);
  cg.sampleAudio = (label, ms) =>
    new Promise((resolve) => {
      const samples = [];
      const clockFrom = audioClock();
      const timer = setInterval(() => samples.push(cg.audio()), 50);
      setTimeout(() => {
        clearInterval(timer);
        const peak = samples.reduce((a, s) => ({ rms: Math.max(a.rms, s.rms), running: Math.max(a.running, s.running), media: Math.max(a.media, s.media) }), { rms: 0, running: 0, media: 0 });
        rec(label, 'probe', [peak.rms, peak.running, peak.media, Math.round((audioClock() - clockFrom) * 1000)]);
        resolve(peak);
      }, ms);
    });

  const dialogSelector = cfg.dialog || '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';
  const labelOf = (el) => {
    const heading = el.querySelector('h1,h2,h3,[role="heading"]');
    const label = el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.id || (heading && heading.textContent.trim()) || String(el.className || el.tagName).split(' ')[0];
    return label.slice(0, 40);
  };
  const visible = (el) => {
    if (el.getClientRects().length === 0) {
      return false;
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && Number(style.opacity) > 0;
  };
  let open = new Map();
  let queued = false;
  const scan = () => {
    queued = false;
    const now = new Map();
    for (const el of document.querySelectorAll(dialogSelector)) {
      // A dialog nested in another one is the same window for the reviewer.
      if (visible(el) && !el.parentElement?.closest(dialogSelector)) {
        now.set(el, open.get(el) || labelOf(el));
      }
    }
    for (const [el, label] of now) {
      if (!open.has(el)) {
        rec('dialog.open', 'ui', [label]);
      }
    }
    for (const [el, label] of open) {
      if (!now.has(el)) {
        rec('dialog.close', 'ui', [label]);
      }
    }
    open = now;
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(scan);
    }
  };
  const observe = () => {
    new MutationObserver(queue).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-hidden'] });
    queue();
  };
  if (document.documentElement) {
    observe();
  } else {
    document.addEventListener('DOMContentLoaded', observe);
  }
  // A window fading in has opacity 0 at the mutation and no mutation after it: rescan on a timer.
  setInterval(scan, 100);
})();
