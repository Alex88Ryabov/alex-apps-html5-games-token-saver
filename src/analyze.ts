// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Pure verdicts from the probe log; a rule the run could not reach is unchecked with a reason, never a pass.

import { mb } from './format.js';
import { LIMITS } from './rules.js';
import type { StepOutcome } from './steps.js';
import type { CgEvent, Finding, Unchecked } from './types.js';

export interface SessionData {
  log: CgEvent[];
  timeOrigin: number;
  served: Array<{ at: number; bytes: number }>;
  external: string[];
  missing: string[];
  consoleErrors: string[];
  booted: boolean;
  steps: StepOutcome;
  stepCount: number;
}

export interface Verdict {
  ok: boolean;
  fail: Finding[];
  warn: Finding[];
  unchecked: Unchecked[];
  passed: string[];
  stats: Record<string, unknown>;
}

// Calls a running game repeats on its own; anything else repeating with no input is a render or a timer.
const IDLE_ALLOWED = new Set([
  'data.setItem',
  'game.gameplayStart',
  'game.gameplayStop',
  'game.happytime',
  'banner.requestBanner',
  'banner.requestResponsiveBanner',
  'banner.clearBanner',
  'banner.clearAllBanners',
]);
// Not measured, picked by eye from the shape of each rule. Three idle hits is a loop, one or two a timer.
const IDLE_REPEAT_FAIL = 3;
// Outside idle: four hits of one member within four seconds is a per-second timer or a render.
const REPEAT_COUNT = 4;
const REPEAT_WINDOW_MS = 4_000;
// Stop and start this close, with no scenario step between them, come from one render.
const FLICKER_MS = 100;
// The game gets this long after a window opens to send gameplayStop.
const DIALOG_REACTION_MS = 500;
// A second rewarded request this soon after the retry click is that click's, not a later step's.
const RETRY_WINDOW_MS = 2_000;
const HIDE_SAVE_MS = 1_000;
// The game timer fires at 30.0-30.2 s; anything up to this is the same 30 s rhythm.
const AUTOSAVE_SLACK_MS = 1_500;
const SILENCE_RMS = 0.001;
const BANNER_ASKED_MS = 35_000;
// Not measured: the sample lasts 250 ms, a live audio clock moves most of that.
const AUDIO_CLOCK_MIN_MS = 100;
// Chromium's own audio device failure in headless, not the game's.
const BROWSER_NOISE = /AudioContext encountered an error from the audio device/;
const SAMPLE = 3;

const GAMEPLAY = new Set(['game.gameplayStart', 'game.gameplayStop']);
// Keys telemetry libraries write for themselves (PostHog, Sentry, GA, Amplitude): not progress.
const TELEMETRY_KEY = /^(ph_|__mplssupport__|sentry|_ga|amp_|amplitude)/i;

// data.* is keyed by its item: reading several keys is normal, one key again and again is not.
function memberOf(e: CgEvent): string {
  return e.n.startsWith('data.') ? `${e.n}(${String(e.a?.[0])})` : e.n;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function analyze(data: SessionData): Verdict {
  const fail: Finding[] = [];
  const warn: Finding[] = [];
  const unchecked: Unchecked[] = [];
  const passed: string[] = [];
  const { log } = data;
  const calls = log.filter((e) => e.k === 'call');
  const mark = (name: string): number | undefined => log.find((e) => e.n === name)?.t;
  const idleFrom = mark('phase.idle');
  const idleTo = mark('phase.idleEnd');
  const hiddenAt = mark('phase.hidden');
  const gameplay = calls.filter((e) => GAMEPLAY.has(e.n));
  const playingAt = (t: number): boolean => {
    let state = false;
    for (const e of gameplay) {
      if (e.t > t) {
        break;
      }
      state = e.n === 'game.gameplayStart';
    }
    return state;
  };
  const scenarioComplete = data.stepCount > 0 && data.steps.failed === undefined;

  if (!data.booted) {
    fail.push({ rule: 'boot', got: 'neither loadingStop nor gameplayStart within 45 s', want: 'the game reaches the SDK' });
  }

  const firstStart = calls.find((e) => e.n === 'game.gameplayStart');
  let initialBytes: number | undefined;
  if (firstStart === undefined) {
    if (scenarioComplete) {
      fail.push({ rule: 'firstGameplay', got: 'no gameplayStart after the whole scenario', want: 'gameplayStart when play begins' });
    } else {
      unchecked.push({ rule: 'firstGameplay', why: data.stepCount === 0 ? 'no gameplayStart without input: pass steps that start play' : 'the scenario stopped early' });
    }
  } else {
    passed.push('firstGameplay');
    const until = data.timeOrigin + firstStart.t;
    const bytes = data.served.filter((s) => s.at <= until).reduce((sum, s) => sum + s.bytes, 0);
    initialBytes = bytes;
    if (bytes > LIMITS.initialBytes) {
      fail.push({ rule: 'initialDownload', got: `${mb(bytes)} MB before gameplayStart`, want: '<= 50 MB' });
    } else if (bytes > LIMITS.initialBytesMobile) {
      warn.push({ rule: 'initialDownloadMobile', got: `${mb(bytes)} MB before gameplayStart`, want: '<= 20 MB for the mobile homepage' });
    } else {
      passed.push('initialDownload');
    }
  }

  const loadingStop = calls.find((e) => e.n === 'game.loadingStop');
  const loadingStart = calls.find((e) => e.n === 'game.loadingStart');
  if (loadingStop !== undefined && (loadingStart === undefined || loadingStart.t > loadingStop.t)) {
    warn.push({ rule: 'loading', got: 'loadingStop without an earlier loadingStart' });
  } else if (loadingStop !== undefined && firstStart !== undefined && loadingStop.t > firstStart.t) {
    warn.push({ rule: 'loading', got: `loadingStop at ${seconds(loadingStop.t)} after the first gameplayStart at ${seconds(firstStart.t)}` });
  }

  const doubles: string[] = [];
  const flickers: string[] = [];
  for (let i = 1; i < gameplay.length; i++) {
    const prev = gameplay[i - 1] as CgEvent;
    const cur = gameplay[i] as CgEvent;
    if (prev.n === cur.n) {
      doubles.push(`${cur.n.slice(5)} twice at ${seconds(cur.t)}`);
    } else if (cur.t - prev.t < FLICKER_MS && !log.some((e) => e.n === 'step' && e.t > prev.t && e.t <= cur.t)) {
      flickers.push(`${prev.n.slice(5)}->${cur.n.slice(5)} in ${cur.t - prev.t}ms at ${seconds(cur.t)}`);
    }
  }
  if (doubles.length > 0) {
    fail.push({ rule: 'pairs', got: `${doubles.length} repeated: ${doubles.slice(0, SAMPLE).join('; ')}`, want: 'start and stop alternate' });
  }
  if (flickers.length > 0) {
    fail.push({ rule: 'pairs', got: `${flickers.length} flicker pairs: ${flickers.slice(0, SAMPLE).join('; ')}`, want: 'no stop+start within one render' });
  }
  if (doubles.length === 0 && flickers.length === 0 && gameplay.length > 0) {
    passed.push('pairs');
  }

  // A window shows a frame or a fade after its click, after the stop: a stop just before it is its own.
  // Tied to the step that caused them, not a clock: under heavy 3D the stop came 10 s after the click.
  const stepTimes = log.filter((e) => e.n === 'step').map((e) => e.t);
  // Only an action causes anything; a wait or a check between the action and its effect does not.
  const actionTimes = log.filter((e) => e.n === 'step' && !/^\{"(wait|waitFor|check)"/.test(String(e.a?.[1]))).map((e) => e.t);
  const causeOf = (t: number): number | undefined => actionTimes.filter((s) => s <= t).pop();
  const settleOf = (t: number, slack: number): number => Math.max(stepTimes.find((s) => s > t) ?? 0, t + slack);
  const opened = log.filter((e) => e.n === 'dialog.open');
  const duringPlay: CgEvent[] = [];
  const notPaused: string[] = [];
  for (const e of opened) {
    // The stop before a window is its own if it ended play and no other window took it first.
    const last = gameplay.filter((g) => g.t <= e.t).pop();
    const taken = last !== undefined && opened.some((o) => o !== e && o.t >= last.t && o.t < e.t);
    if (last?.n === 'game.gameplayStop' && !taken && playingAt(last.t - 1)) {
      duringPlay.push(e);
    } else if (playingAt(e.t)) {
      duringPlay.push(e);
      if (!gameplay.some((g) => g.n === 'game.gameplayStop' && g.t > e.t && g.t <= settleOf(e.t, DIALOG_REACTION_MS))) {
        notPaused.push(String(e.a?.[0]));
      }
    }
  }
  // Closing a window opened in play should resume it. A warning only: a window may lead to a menu.
  const notResumed: string[] = [];
  for (const e of duringPlay) {
    const label = e.a?.[0];
    const close = log.find((c) => c.n === 'dialog.close' && c.t > e.t && c.a?.[0] === label);
    if (close === undefined) {
      continue;
    }
    // The first thing after the closing input: a start resumes, another window chains (menu, then settings).
    const from = Math.max(causeOf(close.t) ?? close.t - DIALOG_REACTION_MS, e.t);
    const next = log.find((g) => g.t > from && ((g.n === 'game.gameplayStart' && g.k === 'call') || (g.n === 'dialog.open' && g !== e)));
    if (next === undefined) {
      notResumed.push(String(label));
    }
  }
  if (notResumed.length > 0) {
    warn.push({ rule: 'pauseOnDialog', got: `no gameplayStart after closing: ${[...new Set(notResumed)].slice(0, SAMPLE).join(', ')}`, want: 'gameplayStart on close, unless the window leads out of play' });
  }
  if (duringPlay.length === 0) {
    unchecked.push({ rule: 'pauseOnDialog', why: opened.length === 0 ? 'no window opened: pass steps that open settings, shop, rewards' : 'windows opened only outside play' });
  } else if (notPaused.length > 0) {
    fail.push({ rule: 'pauseOnDialog', got: `no gameplayStop for: ${[...new Set(notPaused)].slice(0, SAMPLE).join(', ')}`, want: 'gameplayStop on open, gameplayStart on close' });
  } else {
    passed.push('pauseOnDialog');
  }

  // Outside idle, a render loop or a per-second timer in an open window hits one member again and again.
  const byMember = new Map<string, number[]>();
  for (const e of log) {
    const inIdle = idleFrom !== undefined && idleTo !== undefined && e.t >= idleFrom && e.t <= idleTo;
    if ((e.k === 'call' || e.k === 'read') && !inIdle && !IDLE_ALLOWED.has(e.n) && !e.n.startsWith('localStorage.')) {
      const times = byMember.get(memberOf(e)) ?? [];
      times.push(e.t);
      byMember.set(memberOf(e), times);
    }
  }
  const repeats: string[] = [];
  for (const [member, times] of byMember) {
    for (let i = REPEAT_COUNT - 1; i < times.length; i++) {
      if ((times[i] as number) - (times[i - REPEAT_COUNT + 1] as number) <= REPEAT_WINDOW_MS) {
        repeats.push(`${member} x${times.length} from ${seconds(times[0] as number)}`);
        break;
      }
    }
  }
  if (repeats.length > 0) {
    fail.push({ rule: 'sdkRepeats', got: `hit ${REPEAT_COUNT}+ times within ${seconds(REPEAT_WINDOW_MS)}: ${repeats.slice(0, 5).join(', ')}`, want: 'read once at connect and keep the value' });
  } else {
    passed.push('sdkRepeats');
  }

  if (idleFrom === undefined || idleTo === undefined) {
    unchecked.push({ rule: 'sdkReadsIdle', why: 'no idle window (idleSeconds is 0)' });
    unchecked.push({ rule: 'autosave', why: 'no idle window (idleSeconds is 0)' });
  } else {
    const idle = log.filter(
      (e) => e.t >= idleFrom && e.t <= idleTo && (e.k === 'call' || e.k === 'read') && !IDLE_ALLOWED.has(e.n) && !e.n.startsWith('localStorage.'),
    );
    const counts = new Map<string, number>();
    for (const e of idle) {
      counts.set(memberOf(e), (counts.get(memberOf(e)) ?? 0) + 1);
    }
    const span = (idleTo - idleFrom) / 1000;
    const loops = [...counts].filter(([, n]) => n >= IDLE_REPEAT_FAIL).map(([name, n]) => `${name} x${n} (${(n / span).toFixed(1)}/s)`);
    const once = [...counts].filter(([, n]) => n < IDLE_REPEAT_FAIL).map(([name, n]) => `${name} x${n}`);
    if (loops.length > 0) {
      fail.push({ rule: 'sdkReadsIdle', got: `repeated with no input for ${span.toFixed(0)}s: ${loops.slice(0, 5).join(', ')}`, want: 'read once at connect and keep the value' });
    } else {
      passed.push('sdkReadsIdle');
    }
    if (once.length > 0) {
      warn.push({ rule: 'sdkReadsIdle', got: `with no input: ${once.slice(0, 5).join(', ')}` });
    }

    // Only the part of idle spent in play: play may start inside it and stop again on a pause screen.
    const playFrom = playingAt(idleFrom) ? idleFrom : gameplay.find((e) => e.n === 'game.gameplayStart' && e.t > idleFrom && e.t <= idleTo)?.t;
    const playTo = playFrom === undefined ? idleTo : (gameplay.find((e) => e.n === 'game.gameplayStop' && e.t > playFrom && e.t <= idleTo)?.t ?? idleTo);
    if (playFrom === undefined) {
      unchecked.push({ rule: 'autosave', why: 'no play during the idle window: pass steps that start play' });
    } else if (playTo - playFrom < LIMITS.autosaveMs + AUTOSAVE_SLACK_MS) {
      unchecked.push({ rule: 'autosave', why: `only ${seconds(playTo - playFrom)} of play in the idle window, ${seconds(LIMITS.autosaveMs + AUTOSAVE_SLACK_MS)} needed` });
    } else {
      const saves = calls.filter((e) => e.n === 'data.setItem' && e.t <= playTo).map((e) => e.t);
      // Counted from the start of play: a save at boot long before it is not part of the rhythm.
      let last = playFrom;
      let gap = 0;
      for (const t of saves.filter((t) => t > playFrom)) {
        gap = Math.max(gap, t - last);
        last = t;
      }
      gap = Math.max(gap, playTo - last);
      if (gap > LIMITS.autosaveMs + AUTOSAVE_SLACK_MS) {
        fail.push({ rule: 'autosave', got: `${seconds(gap)} of play without data.setItem`, want: 'setItem every 30 s' });
      } else {
        passed.push('autosave');
      }
    }
  }

  if (hiddenAt === undefined) {
    unchecked.push({ rule: 'saveOnHide', why: 'the page was not hidden' });
  } else if (calls.some((e) => e.n === 'data.setItem' && e.t >= hiddenAt && e.t <= hiddenAt + HIDE_SAVE_MS)) {
    passed.push('saveOnHide');
  } else {
    fail.push({ rule: 'saveOnHide', got: 'no data.setItem within 1 s of visibilitychange hidden + pagehide', want: 'save right away on hide' });
  }

  const local = [...new Set(calls.filter((e) => e.n === 'localStorage.setItem').map((e) => String(e.a?.[0])))].filter((key) => !TELEMETRY_KEY.test(key));
  if (local.length > 0) {
    warn.push({ rule: 'localStorage', got: `writes on the portal: ${local.slice(0, 5).join(', ')}`, want: 'progress only in SDK.data' });
  } else {
    passed.push('localStorage');
  }

  const started = log.filter((e) => e.n === 'ad.adStarted');
  const sampled = log.filter((e) => e.n === 'ad.audio');
  if (started.length === 0) {
    unchecked.push({ rule: 'adMuted', why: 'no ad played: pass steps that trigger a midgame or rewarded ad' });
  } else {
    const before = log.filter((e) => e.n === 'ad.before');
    const loud: string[] = [];
    let measured = 0;
    let stalled = 0;
    started.forEach((s, i) => {
      const base = before[i]?.a as [number, number, number, number] | undefined;
      const during = sampled[i]?.a as [number, number, number, number] | undefined;
      if (base === undefined || during === undefined || (base[0] < SILENCE_RMS && base[2] === 0)) {
        return;
      }
      // A running context whose clock stood still repeats a stale buffer (four parallel sessions did that).
      if (during[1] > 0 && during[2] === 0 && during[3] < AUDIO_CLOCK_MIN_MS) {
        stalled++;
        return;
      }
      measured++;
      if (during[0] > Math.max(SILENCE_RMS, base[0] * 0.1) || during[2] > 0) {
        loud.push(`${String(s.a?.[0])}: rms ${during[0]} (before ${base[0]})${during[2] ? `, ${during[2]} media playing` : ''}`);
      }
    });
    if (loud.length > 0) {
      fail.push({ rule: 'adMuted', got: `sound during ads: ${loud.slice(0, SAMPLE).join('; ')}`, want: 'mute on adStarted, unmute on adFinished/adError' });
    } else if (measured === 0 && stalled > 0) {
      unchecked.push({ rule: 'adMuted', why: 'the audio renderer stalled during the ad (machine under load): run again' });
    } else if (measured === 0) {
      unchecked.push({ rule: 'adMuted', why: 'the game was silent before every ad, nothing to mute' });
    } else {
      passed.push('adMuted');
    }
  }

  const retry = mark('rewarded.retry');
  if (retry === undefined) {
    unchecked.push({ rule: 'rewardedCooldown', why: 'pass a rewardedTwice step with the rewarded button selector' });
  } else if (calls.some((e) => e.n === 'ad.requestAd' && e.a?.[0] === 'rewarded' && e.t > retry && e.t <= retry + RETRY_WINDOW_MS)) {
    fail.push({ rule: 'rewardedCooldown', got: 'a second rewarded ad was requested right after the first', want: 'buttons disabled with a countdown after each rewarded ad' });
  } else {
    passed.push('rewardedCooldown');
  }

  // Refresh is per banner container: two banners requested together are not a 0 s refresh.
  const bannerTimes = new Map<string, number[]>();
  for (const e of calls.filter((c) => c.n.startsWith('banner.request'))) {
    const times = bannerTimes.get(String(e.a?.[0])) ?? [];
    times.push(e.t);
    bannerTimes.set(String(e.a?.[0]), times);
  }
  const refreshes = [...bannerTimes.values()].flatMap((times) => times.slice(1).map((t, i) => t - (times[i] as number)));
  const fastest = refreshes.length > 0 ? Math.min(...refreshes) : undefined;
  if (fastest !== undefined && fastest < LIMITS.bannerMinMs) {
    fail.push({ rule: 'bannerRefresh', got: `refresh after ${seconds(fastest)}`, want: '>= 30 s, the SDK refuses faster' });
  } else if (fastest !== undefined && fastest < BANNER_ASKED_MS) {
    warn.push({ rule: 'bannerRefresh', got: `refresh after ${seconds(fastest)}`, want: '35 s, as the reviewer asked' });
  } else if (fastest !== undefined) {
    passed.push('bannerRefresh');
  }

  const errors = [...log.filter((e) => e.n === 'page.error').map((e) => String(e.a?.[0])), ...data.consoleErrors].filter((text) => !BROWSER_NOISE.test(text));
  if (errors.length > 0) {
    fail.push({ rule: 'consoleErrors', got: `${errors.length}: ${[...new Set(errors)].slice(0, SAMPLE).join(' | ')}` });
  } else {
    passed.push('consoleErrors');
  }
  if (data.missing.length > 0) {
    fail.push({ rule: 'missingFiles', got: `404 inside the portal frame: ${data.missing.slice(0, 5).join(', ')}`, want: 'every request resolves inside the build (relative paths)' });
  }
  if (data.external.length > 0) {
    warn.push({ rule: 'externalHosts', got: `requests to ${data.external.slice(0, 5).join(', ')} (blocked in the check)`, want: 'nothing but telemetry; telemetry needs a Privacy Policy link' });
  }
  const missingApi = [...new Set(log.filter((e) => e.k === 'missing').map((e) => e.n))];
  if (missingApi.length > 0) {
    warn.push({ rule: 'emulator', got: `the game used SDK members the emulator lacks: ${missingApi.slice(0, 5).join(', ')}`, want: 'those paths are unchecked' });
  }

  const counts: Record<string, number> = {};
  for (const e of calls) {
    if (!e.n.startsWith('localStorage')) {
      counts[e.n] = (counts[e.n] ?? 0) + 1;
    }
  }
  const lastServed = data.served.at(-1);
  return {
    ok: fail.length === 0,
    fail,
    warn,
    unchecked,
    passed,
    stats: {
      firstGameplayAt: firstStart ? seconds(firstStart.t) : null,
      initialMB: initialBytes === undefined ? null : mb(initialBytes),
      servedMB: mb(data.served.reduce((sum, s) => sum + s.bytes, 0)),
      lastFileAt: lastServed ? seconds(lastServed.at - data.timeOrigin) : null,
      sdkCalls: counts,
      dialogs: [...new Set(opened.map((e) => String(e.a?.[0])))].slice(0, 8),
    },
  };
}
