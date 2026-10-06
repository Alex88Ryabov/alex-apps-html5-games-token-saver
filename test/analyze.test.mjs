// Verdicts from synthetic logs. Each case is a shape seen on a real game or in a reviewer email.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../dist/analyze.js';

const call = (n, t, a) => ({ n, k: 'call', t, a });
const read = (n, t) => ({ n, k: 'read', t });
const mark = (n, t, a) => ({ n, k: 'mark', t, a });
const ui = (n, t, label) => ({ n, k: 'ui', t, a: [label] });
const probe = (n, t, rms, media = 0, running = 1, clockMs = 250) => ({ n, k: 'probe', t, a: [rms, running, media, clockMs] });

function run(log, extra = {}) {
  return analyze({
    log,
    timeOrigin: 0,
    served: [{ at: 10, bytes: 1000 }],
    external: [],
    missing: [],
    consoleErrors: [],
    booted: true,
    steps: { done: 1 },
    stepCount: 1,
    ...extra,
  });
}
const rules = (list) => list.map((f) => f.rule);

// Boot, play from 300 ms, scenario time until 10 s, an idle stretch of 35 s with an autosave, then the tab hidden with a save.
function cleanLog() {
  return [
    call('init', 10),
    call('game.loadingStart', 20),
    call('game.loadingStop', 200),
    call('game.gameplayStart', 300),
    mark('phase.idle', 10_000),
    call('data.setItem', 30_000, ['save']),
    mark('phase.idleEnd', 45_000),
    mark('phase.hidden', 45_100),
    call('data.setItem', 45_120, ['save']),
  ];
}

test('a clean session passes and leaves windows, ads and the cooldown unchecked with reasons', () => {
  const v = run(cleanLog());
  assert.equal(v.ok, true);
  for (const rule of ['firstGameplay', 'initialDownload', 'pairs', 'sdkReadsIdle', 'sdkRepeats', 'autosave', 'saveOnHide', 'localStorage']) {
    assert.ok(v.passed.includes(rule), rule);
  }
  assert.deepEqual(rules(v.unchecked).sort(), ['adMuted', 'pauseOnDialog', 'rewardedCooldown']);
});

test('reviewer 2026-10-01: isUserAccountAvailable read every second in an open window', () => {
  const log = [...cleanLog(), ...[5000, 6000, 7000, 8000].map((t) => read('user.isUserAccountAvailable', t))];
  const v = run(log);
  assert.ok(rules(v.fail).includes('sdkRepeats'));
});

test('reads repeated while idle fail; one or two only warn', () => {
  const loop = run([...cleanLog(), ...[12_000, 13_000, 14_000].map((t) => call('game.inviteLink', t))]);
  assert.ok(rules(loop.fail).includes('sdkReadsIdle'));
  const once = run([...cleanLog(), call('game.inviteLink', 12_000)]);
  assert.ok(!rules(once.fail).includes('sdkReadsIdle'));
  assert.ok(rules(once.warn).includes('sdkReadsIdle'));
});

test('several data keys read at boot are not a repeat', () => {
  const log = [...cleanLog(), ...['a', 'b', 'c', 'd'].map((key, i) => call('data.getItem', 30 + i, [key]))];
  assert.ok(!rules(run(log).fail).includes('sdkRepeats'));
});

test('reviewer 2026-09-30: autosave once a minute fails, play started inside idle still counts', () => {
  const log = cleanLog().filter((e) => !(e.n === 'data.setItem' && e.t === 30_000));
  const v = run(log);
  assert.equal(v.fail.find((f) => f.rule === 'autosave')?.got, '35.0s of play without data.setItem');
  // BlockyBarber: gameplayStart 100 ms after the idle mark.
  const late = cleanLog().map((e) => (e.n === 'game.gameplayStart' ? { ...e, t: 10_100 } : e));
  assert.ok(run(late).passed.includes('autosave'));
});

test('no save on hide fails', () => {
  const v = run(cleanLog().filter((e) => e.t !== 45_120));
  assert.ok(rules(v.fail).includes('saveOnHide'));
});

test('a window in play: stop on open passes, no stop fails, no resume on close warns', () => {
  const paused = [...cleanLog(), call('game.gameplayStop', 5000), ui('dialog.open', 5016, 'shop'), call('game.gameplayStart', 6000), ui('dialog.close', 6016, 'shop')];
  assert.ok(run(paused).passed.includes('pauseOnDialog'));
  const notPaused = [...cleanLog(), ui('dialog.open', 5016, 'shop')];
  assert.ok(rules(run(notPaused).fail).includes('pauseOnDialog'));
  const notResumed = [...cleanLog(), call('game.gameplayStop', 5000), ui('dialog.open', 5016, 'shop'), ui('dialog.close', 6016, 'shop')];
  assert.ok(rules(run(notResumed).warn).includes('pauseOnDialog'));
});

test('a window before play is not a pause case', () => {
  const log = [call('game.loadingStop', 100), ui('dialog.open', 150, 'daily'), call('game.gameplayStart', 900)];
  assert.equal(run(log).unchecked.find((u) => u.rule === 'pauseOnDialog')?.why, 'windows opened only outside play');
});

test('double start fails; a scripted close right after an open is not a flicker', () => {
  const doubled = [...cleanLog(), call('game.gameplayStart', 400)];
  assert.ok(rules(run(doubled).fail).includes('pairs'));
  const scripted = [...cleanLog(), call('game.gameplayStop', 5000), mark('step', 5010), call('game.gameplayStart', 5018)];
  assert.ok(run(scripted).passed.includes('pairs'));
  const flicker = [...cleanLog(), call('game.gameplayStop', 5000), call('game.gameplayStart', 5018)];
  assert.ok(rules(run(flicker).fail).includes('pairs'));
});

test('sound during an ad fails; silence before the ad leaves it unchecked', () => {
  const ad = (before, during) => [...cleanLog(), call('ad.requestAd', 7000, ['midgame']), probe('ad.before', 7250, before), { n: 'ad.adStarted', k: 'event', t: 7300, a: ['midgame'] }, probe('ad.audio', 7850, during)];
  assert.ok(rules(run(ad(0.14, 0.14)).fail).includes('adMuted'));
  assert.ok(run(ad(0.14, 0)).passed.includes('adMuted'));
  assert.equal(run(ad(0, 0)).unchecked.find((u) => u.rule === 'adMuted')?.why, 'the game was silent before every ad, nothing to mute');
});

test('a stalled audio clock is unchecked, a suspended context is silence', () => {
  const ad = (during) => [...cleanLog(), call('ad.requestAd', 7000, ['midgame']), probe('ad.before', 7250, 0.0032), { n: 'ad.adStarted', k: 'event', t: 7300, a: ['midgame'] }, during];
  assert.match(run(ad(probe('ad.audio', 7850, 0.0032, 0, 1, 0))).unchecked.find((u) => u.rule === 'adMuted')?.why ?? '', /stalled/);
  assert.ok(run(ad(probe('ad.audio', 7850, 0, 0, 0, 0))).passed.includes('adMuted'));
});

test('a second rewarded request right after the first fails the cooldown', () => {
  const twice = [...cleanLog(), call('ad.requestAd', 7000, ['rewarded']), mark('rewarded.retry', 9000), call('ad.requestAd', 9010, ['rewarded'])];
  assert.ok(rules(run(twice).fail).includes('rewardedCooldown'));
  const blocked = [...cleanLog(), call('ad.requestAd', 7000, ['rewarded']), mark('rewarded.retry', 9000)];
  assert.ok(run(blocked).passed.includes('rewardedCooldown'));
  // A rewarded ad a later step asks for, minutes on, is not the retry's.
  const later = [...blocked, call('ad.requestAd', 200_000, ['rewarded'])];
  assert.ok(run(later).passed.includes('rewardedCooldown'));
});

test('review: a save at boot long before play does not stretch the autosave gap', () => {
  // setItem at boot, play from 10.1 s, saves every 30 s after it: the rhythm is 30 s, not 39 s.
  const log = cleanLog()
    .filter((e) => e.n !== 'data.setItem')
    .map((e) => (e.n === 'game.gameplayStart' ? { ...e, t: 10_100 } : e))
    .concat([call('data.setItem', 1000, ['save']), call('data.setItem', 40_000, ['save']), call('data.setItem', 45_120, ['save'])]);
  assert.ok(run(log).passed.includes('autosave'));
});

test('review: a start before the window opened is not a resume after it closed', () => {
  const log = [...cleanLog(), call('game.gameplayStart', 5000), call('game.gameplayStop', 5100), ui('dialog.open', 5116, 'settings'), ui('dialog.close', 5400, 'settings')];
  assert.ok(rules(run(log).warn).includes('pauseOnDialog'));
});

test('TowerDefence under SwiftShader: stop 10 s after the click, window 3.5 s after the stop', () => {
  const log = [
    ...cleanLog(),
    mark('step', 18_382),
    call('game.gameplayStop', 28_629),
    mark('step', 29_783),
    mark('step', 30_951),
    ui('dialog.open', 32_094, 'Paused'),
    ui('dialog.close', 39_981, 'Paused'),
    ui('dialog.open', 43_498, 'Settings'),
    mark('step', 42_318),
    ui('dialog.close', 52_448, 'Settings'),
    mark('step', 54_670),
    ui('dialog.open', 55_810, 'Paused'),
    call('game.gameplayStart', 65_105),
    ui('dialog.close', 65_109, 'Paused'),
    mark('step', 66_231),
  ].sort((a, b) => a.t - b.t);
  const v = run(log);
  assert.ok(v.passed.includes('pauseOnDialog'));
  assert.ok(!rules(v.warn).includes('pauseOnDialog'));
});

test('MuscleTitans: the close is seen after a wait step, the start came right after the tap', () => {
  const log = [
    ...cleanLog(),
    mark('step', 1615, [8, '{"click":"data-testid=bonuses-open"}']),
    call('game.gameplayStop', 1628),
    ui('dialog.open', 1629, 'bonuses-modal'),
    mark('step', 5301, [11, '{"tap":[0.005,0.005]}']),
    call('game.gameplayStart', 5304),
    mark('step', 5306, [12, '{"wait":300}']),
    ui('dialog.close', 5310, 'bonuses-modal'),
  ];
  assert.ok(!rules(run(log).warn).includes('pauseOnDialog'));
});

test('review: a window opened from another one is not a missed resume', () => {
  const log = [...cleanLog(), call('game.gameplayStop', 5000), ui('dialog.open', 5016, 'menu'), ui('dialog.close', 6016, 'menu'), ui('dialog.open', 6020, 'settings')];
  assert.ok(!rules(run(log).warn).includes('pauseOnDialog'));
});

test('review: several data keys read while idle are not a loop', () => {
  const log = [...cleanLog(), ...['a', 'b', 'c'].map((key, i) => call('data.getItem', 12_000 + i, [key]))];
  assert.ok(!rules(run(log).fail).includes('sdkReadsIdle'));
});

test('telemetry keys in localStorage are ignored, a game key warns', () => {
  const log = [...cleanLog(), call('localStorage.setItem', 50, ['ph_phc_x']), call('localStorage.setItem', 60, ['__mplssupport__'])];
  assert.ok(run(log).passed.includes('localStorage'));
  const game = [...cleanLog(), call('localStorage.setItem', 70, ['mt.save.v1'])];
  assert.match(run(game).warn.find((f) => f.rule === 'localStorage')?.got ?? '', /mt\.save\.v1/);
});

test('banner: faster than 30 s fails, 30-35 s warns, two containers are not a refresh', () => {
  const banner = (t, id = '#top') => call('banner.requestBanner', t, [id]);
  assert.ok(rules(run([...cleanLog(), banner(1000), banner(21_000)]).fail).includes('bannerRefresh'));
  assert.ok(rules(run([...cleanLog(), banner(1000), banner(33_000)]).warn).includes('bannerRefresh'));
  assert.ok(run([...cleanLog(), banner(1000), banner(37_000)]).passed.includes('bannerRefresh'));
  assert.ok(!rules(run([...cleanLog(), banner(1000, '#top'), banner(1010, '#side')]).fail).includes('bannerRefresh'));
});

test('bytes before the first gameplayStart are the initial download', () => {
  const big = run(cleanLog(), { served: [{ at: 100, bytes: 30 * 1024 * 1024 }, { at: 5000, bytes: 40 * 1024 * 1024 }] });
  assert.ok(rules(big.warn).includes('initialDownloadMobile'));
  assert.equal(big.stats.initialMB, 30);
});

test('no gameplayStart: unchecked without steps, failed after a whole scenario', () => {
  const log = [call('game.loadingStop', 100)];
  assert.ok(rules(run(log, { stepCount: 0, steps: { done: 0 } }).unchecked).includes('firstGameplay'));
  assert.ok(rules(run(log).fail).includes('firstGameplay'));
});

test('an SDK member the emulator lacks is reported, not passed silently', () => {
  const v = run([...cleanLog(), { n: 'game.someNewApi', k: 'missing', t: 50 }]);
  assert.match(v.warn.find((f) => f.rule === 'emulator')?.got ?? '', /game\.someNewApi/);
});
