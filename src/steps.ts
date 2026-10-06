// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// The game-specific part: Playwright selectors in the game frame, taps as viewport fractions.

import type { Frame, Page } from 'playwright-core';
import type { CgWindow } from './types.js';

export type Step =
  | { click: string }
  | { tap: [number, number] }
  | { press: string; holdMs?: number }
  | { wait: number }
  | { waitFor: string; timeoutMs?: number }
  | { eval: string }
  | { check: string }
  | { rewardedTwice: string };

export interface StepOutcome {
  done: number;
  failed?: { step: number; error: string };
}

const STEP_TIMEOUT_MS = 10_000;
// Not measured: a rewarded button still on screen after the ad is there within this window.
const RETRY_CLICK_MS = 1_500;
// Not measured: a game may request the ad a tick after the click.
const REQUEST_SETTLE_MS = 300;
// The emulator ends an ad in about 1.9 s (stub.js timings); this is a ceiling, not a wait.
const AD_FINISH_MS = 10_000;

export interface StepContext {
  page: Page;
  frame: Frame;
  // Frame audit measures here; the SDK session only marks the moment in the log.
  onCheck?: (label: string) => Promise<void>;
  // The audit skips steps that would play an ad: it measures layout, not SDK traffic.
  skipAds?: boolean;
  // A phone context: taps are touches, games listening to touchstart ignore mouse clicks.
  touch?: boolean;
}

export function describe(step: Step): string {
  return JSON.stringify(step).slice(0, 80);
}

export async function runSteps(steps: Step[], ctx: StepContext): Promise<StepOutcome> {
  const { page, frame } = ctx;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Step;
    try {
      await frame.evaluate(([n, label]) => (window as unknown as CgWindow).__cg?.rec('step', 'mark', [n, label]), [i, describe(step)] as const);
      if ('click' in step) {
        await click(ctx, step.click, STEP_TIMEOUT_MS);
      } else if ('tap' in step) {
        const size = page.viewportSize() ?? { width: 1280, height: 720 };
        await pointAt(ctx, step.tap[0] * size.width, step.tap[1] * size.height);
      } else if ('press' in step) {
        await focusGame(page);
        if (step.holdMs) {
          await page.keyboard.down(step.press);
          await page.waitForTimeout(step.holdMs);
          await page.keyboard.up(step.press);
        } else {
          await page.keyboard.press(step.press);
        }
      } else if ('wait' in step) {
        await page.waitForTimeout(step.wait);
      } else if ('waitFor' in step) {
        await frame.locator(step.waitFor).first().waitFor({ timeout: step.timeoutMs ?? STEP_TIMEOUT_MS });
      } else if ('eval' in step) {
        await frame.evaluate(step.eval);
      } else if ('check' in step) {
        await ctx.onCheck?.(step.check);
      } else if (!ctx.skipAds) {
        await rewardedTwice(ctx, step.rewardedTwice);
      }
    } catch (error) {
      return { done: i, failed: { step: i, error: `${describe(step)}: ${reason(error)}` } };
    }
  }
  return { done: steps.length };
}

// The first line says what timed out; the last line of Playwright's call log says why.
function reason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).slice(0, 160);
  }
  const lines = error.message.replace(/\u001b\[\d+m/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const last = lines.length > 1 ? lines[lines.length - 1] : undefined;
  return (last && last !== first ? `${first} (${last})` : first).slice(0, 240);
}

async function pointAt(ctx: StepContext, x: number, y: number): Promise<void> {
  if (ctx.touch) {
    await ctx.page.touchscreen.tap(x, y);
  } else {
    await ctx.page.mouse.click(x, y);
  }
}

// A player's click at the centre: locator.click waits for stability and navigations, which hang in games.
async function click(ctx: StepContext, selector: string, timeout: number): Promise<void> {
  const target = ctx.frame.locator(selector).first();
  await target.waitFor({ state: 'visible', timeout });
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error(`${selector} has no box on screen`);
  }
  await pointAt(ctx, box.x + box.width / 2, box.y + box.height / 2);
}

// Keys go to the focused frame; the game frame gets focus the way a player gives it, by the iframe.
async function focusGame(page: Page): Promise<void> {
  await page.locator('iframe').first().focus();
}

// Watch, then click again at once, as a player would: the second request must not reach the SDK.
async function rewardedTwice(ctx: StepContext, selector: string): Promise<void> {
  const { frame } = ctx;
  const ended = (): number =>
    (window as unknown as CgWindow).__cg?.log.filter((e) => (e.n === 'ad.adFinished' || e.n === 'ad.adError') && e.a?.[0] === 'rewarded').length ?? 0;
  const before = await frame.evaluate(ended);
  await click(ctx, selector, STEP_TIMEOUT_MS);
  await frame.waitForFunction(
    (n) => ((window as unknown as CgWindow).__cg?.log.filter((e) => (e.n === 'ad.adFinished' || e.n === 'ad.adError') && e.a?.[0] === 'rewarded').length ?? 0) > n,
    before,
    { timeout: AD_FINISH_MS },
  );
  await frame.evaluate(() => (window as unknown as CgWindow).__cg?.rec('rewarded.retry', 'mark'));
  // A button gone or hidden after the ad is a pass; a disabled one ignores the click by itself.
  await click(ctx, selector, RETRY_CLICK_MS).catch(() => undefined);
  await frame.waitForTimeout(REQUEST_SETTLE_MS);
  // A game without a cooldown plays a second ad; the next steps wait for it, or they click into its overlay.
  await frame
    .waitForFunction(
      () => {
        const log = (window as unknown as CgWindow).__cg?.log ?? [];
        const requested = log.filter((e) => e.n === 'ad.requestAd' && e.a?.[0] === 'rewarded').length;
        return log.filter((e) => (e.n === 'ad.adFinished' || e.n === 'ad.adError') && e.a?.[0] === 'rewarded').length >= requested;
      },
      undefined,
      { timeout: AD_FINISH_MS, polling: 100 },
    )
    .catch(() => undefined);
}

