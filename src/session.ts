// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Boot, scenario, idle with no input, hidden tab; phases are marked in the page clock.

import { analyze, type Verdict } from './analyze.js';
import { launch, openGame, waitBoot, type Engine } from './browser.js';
import type { Build } from './game.js';
import { runSteps, type Step, type StepOutcome } from './steps.js';
import type { CgWindow } from './types.js';

export interface SessionOptions {
  steps: Step[];
  query?: string;
  init?: string;
  dialog?: string;
  idleSeconds: number;
  engine: Engine;
  sdk?: Record<string, unknown>;
}

// Not measured: the tab-hide save gets this long to land before the log is read.
const AFTER_HIDE_MS = 1_200;
// Longer than the repeat window of the analysis (4 s), so a per-second tick gets four hits.
const CHECK_HOLD_MS = 4_500;

export async function runSession(build: Build, options: SessionOptions): Promise<Verdict & { scenario: StepOutcome; ms: number }> {
  const started = Date.now();
  const browser = await launch(build.root, options.engine);
  try {
    const game = await openGame(browser, build, {
      viewport: { width: 1280, height: 720 },
      query: options.query,
      init: options.init,
      dialog: options.dialog,
      sdk: options.sdk,
    });
    const mark = (name: string): Promise<void> =>
      game.frame.evaluate((n) => (window as unknown as CgWindow).__cg?.rec(n, 'mark'), name);
    const booted = await waitBoot(game);
    // A check point is held so a render loop or a per-second timer in that screen has time to show.
    const steps = await runSteps(options.steps, { page: game.page, frame: game.frame, onCheck: () => game.page.waitForTimeout(CHECK_HOLD_MS) });
    if (options.idleSeconds > 0) {
      await mark('phase.idle');
      await game.page.waitForTimeout(options.idleSeconds * 1000);
      await mark('phase.idleEnd');
    }
    await game.frame.evaluate(() => {
      (window as unknown as CgWindow).__cg?.rec('phase.hidden', 'mark');
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await game.page.waitForTimeout(AFTER_HIDE_MS);
    const verdict = analyze({
      log: await game.log(),
      timeOrigin: game.timeOrigin,
      served: game.served,
      external: [...game.external],
      missing: [...game.missing],
      consoleErrors: game.consoleErrors,
      booted,
      steps,
      stepCount: options.steps.length,
    });
    return { ...verdict, scenario: steps, ms: Date.now() - started };
  } finally {
    await browser.close();
  }
}
