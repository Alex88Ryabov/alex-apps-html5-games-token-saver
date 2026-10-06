// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Layout per portal frame size as findings, measured at boot, at each check step and at the end.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openGame, waitBoot, type Engine } from './browser.js';
import { InputError } from './format.js';
import type { Build } from './game.js';
import { measure, type Measured } from './measure.js';
import { runSteps, type Step } from './steps.js';
import type { Finding, Unchecked } from './types.js';

export interface Size {
  width: number;
  height: number;
  mobile: boolean;
}

// The owner's portal sizes plus full HD from the docs range; not the docs' full list of ten.
export const DEFAULT_SIZES = ['800x450', '1080x607', '1920x1080', '390x664m', '666x380m'];

const DIALOG = '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';
const SAMPLE = 5;
// A ceiling, not measured: UI transitions run well under a second.
const ANIMATION_WAIT_MS = 2_000;

export function parseSize(text: string): Size {
  const match = /^(\d{3,4})x(\d{3,4})(m?)$/.exec(text.trim());
  if (match === null) {
    throw new InputError(`bad size ${text}`, 'WxH, with m for a touch phone: 390x664m');
  }
  return { width: Number(match[1]), height: Number(match[2]), mobile: match[3] === 'm' };
}

export interface AuditOptions {
  steps: Step[];
  query?: string;
  init?: string;
  dialog?: string;
  sizes: string[];
  minTextPx: number;
  engine: Engine;
  shots: boolean;
}

interface Point {
  size: string;
  mobile: boolean;
  point: string;
  m: Measured;
}

export async function runAudit(build: Build, options: AuditOptions): Promise<Record<string, unknown>> {
  const started = Date.now();
  const sizes = options.sizes.map((text) => ({ text, ...parseSize(text) }));
  const dialog = options.dialog ?? DIALOG;
  const shotDir = join(tmpdir(), 'html5-games-token-saver', build.slug);
  const browser = await launch(build.root, options.engine);
  const points: Point[] = [];
  const shots: string[] = [];
  const scenario: Record<string, string> = {};
  try {
    for (const size of sizes) {
      const game = await openGame(browser, build, {
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: size.mobile ? 2 : 1,
        mobile: size.mobile,
        query: options.query,
        init: options.init,
        dialog,
      });
      const take = async (point: string): Promise<void> => {
        // A window scaling in measured 5.6 px text mid-animation (MuscleTitans settings): wait for finite ones.
        await game.frame.evaluate(
          (ms) =>
            Promise.race([
              Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
              new Promise((resolve) => setTimeout(resolve, ms)),
            ]),
          ANIMATION_WAIT_MS,
        );
        const m = await game.frame.evaluate(measure, { minPx: options.minTextPx, dialog });
        const at = { size: size.text, mobile: size.mobile, point, m };
        points.push(at);
        const verdict = judge([at], options.minTextPx);
        if (options.shots && verdict.fail.length + verdict.warn.length > 0) {
          mkdirSync(shotDir, { recursive: true });
          const path = join(shotDir, `${size.text}-${point.replace(/[^\w-]+/g, '_')}.png`);
          await game.page.screenshot({ path });
          shots.push(path);
        }
      };
      await waitBoot(game);
      await take('boot');
      const outcome = await runSteps(options.steps, { page: game.page, frame: game.frame, onCheck: take, skipAds: true, touch: size.mobile });
      if (outcome.failed) {
        scenario[size.text] = outcome.failed.error;
      }
      await take('end');
      await game.context.close();
    }
  } finally {
    await browser.close();
  }
  return { ...judge(points, options.minTextPx), scenario, shots, ms: Date.now() - started };
}

export function judge(points: Point[], minPx: number): { ok: boolean; fail: Finding[]; warn: Finding[]; unchecked: Unchecked[]; points: number } {
  // rule -> detail -> where: one broken button seen at fifteen points is one finding with its places.
  const found = new Map<string, Map<string, { sizes: Set<string>; points: Set<string> }>>();
  const add = (rule: string, detail: string, size: string, point: string): void => {
    const details = found.get(rule) ?? new Map<string, { sizes: Set<string>; points: Set<string> }>();
    const where = details.get(detail) ?? { sizes: new Set<string>(), points: new Set<string>() };
    where.sizes.add(size);
    where.points.add(point);
    details.set(detail, where);
    found.set(rule, details);
  };
  for (const { size, mobile, point, m } of points) {
    for (const d of m.dialogs) {
      if (!d.fits) {
        add('dialogFits', `${d.label} at ${d.box} in ${m.vw}x${m.vh}`, size, point);
      }
      if (d.controlsOutside.length > 0) {
        add('dialogFits', `${d.label} unreachable ${d.controlsOutside.join(', ')}`, size, point);
      }
    }
    if (m.pageOverflow > 0) {
      add('pageOverflow', `${m.pageOverflow}px wider than the frame`, size, point);
    }
    if (m.smallText.count > 0) {
      add('textSize', `${m.smallText.count} below ${minPx}px: ${m.smallText.samples.join(', ')}`, size, point);
    }
    for (const u of m.unequal) {
      add('equalButtons', u, size, point);
    }
    if (mobile) {
      for (const s of m.scrollers.filter((s) => !s.customBar)) {
        add('iosScrollbar', s.label, size, point);
      }
    }
  }
  const pack = (rule: string, want: string): Finding => {
    const items = [...(found.get(rule) ?? new Map())].map(([detail, where]) => `${detail} @${[...where.sizes].join(',')} ${[...where.points].join(',')}`);
    const more = items.length > SAMPLE ? ` and ${items.length - SAMPLE} more` : '';
    return { rule, got: items.slice(0, SAMPLE).join(' | ') + more, want };
  };
  const fail: Finding[] = [];
  const warn: Finding[] = [];
  const WANT: Record<string, string> = {
    dialogFits: 'the card inside the frame, every control reachable or in a scroller',
    pageOverflow: 'no horizontal overflow',
    textSize: `rendered text >= ${minPx}px`,
    equalButtons: 'the no-ad button the same size as the rewarded one',
  };
  for (const [rule, want] of Object.entries(WANT)) {
    if (found.has(rule)) {
      fail.push(pack(rule, want));
    }
  }
  // A custom bar is guessed from class names and roles, so a miss is a lead, not a verdict.
  if (found.has('iosScrollbar')) {
    warn.push(pack('iosScrollbar', 'a visible custom scrollbar (iOS hides the native one); no bar-like element found next to these'));
  }
  const unchecked: Unchecked[] = [];
  // Not measured: a canvas over 80% of the frame with no text in the DOM is a canvas-drawn interface.
  if (points.length > 0 && points.every((p) => p.m.textNodes === 0 && p.m.canvasShare > 0.8)) {
    unchecked.push({ rule: 'layout', why: 'the interface is drawn on a canvas, there is no DOM to measure: use screenshots' });
  }
  if (!points.some((p) => p.m.dialogs.length > 0)) {
    unchecked.push({ rule: 'dialogFits', why: 'no window was open at any point: add steps that open windows, then a check step' });
  }
  if (!points.some((p) => p.m.rewarded > 0)) {
    unchecked.push({ rule: 'equalButtons', why: 'no rewarded button on screen at any point (words watch/video/ad or data-rewarded)' });
  }
  return { ok: fail.length === 0, fail, warn, unchecked, points: points.length };
}
