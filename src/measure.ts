// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Serialized by Playwright into the game frame: self-contained, no imports, no outside helpers.

export interface Measured {
  vw: number;
  vh: number;
  textNodes: number;
  canvasShare: number;
  pageOverflow: number;
  dialogs: Array<{ label: string; fits: boolean; box: string; controlsOutside: string[] }>;
  smallText: { count: number; samples: string[] };
  rewarded: number;
  unequal: string[];
  scrollers: Array<{ label: string; customBar: boolean }>;
}

export function measure(args: { minPx: number; dialog: string }): Measured {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const labelOf = (el: Element): string => {
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.id || String(el.className || el.tagName).split(' ')[0] || '');
    return text && !name.includes(text) ? `${name} «${text}»` : name;
  };
  const visible = (el: Element): boolean => {
    if (el.getClientRects().length === 0) {
      return false;
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && Number(style.opacity) > 0 && style.display !== 'none';
  };
  const scrollable = (el: Element): boolean => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  const inScroller = (el: Element, within: Element): boolean => {
    for (let p = el.parentElement; p !== null && within.contains(p); p = p.parentElement) {
      if (scrollable(p)) {
        return true;
      }
    }
    return false;
  };
  const outside = (r: DOMRect): boolean => r.bottom > vh + 1 || r.top < -1 || r.right > vw + 1 || r.left < -1;

  const dialogs = [...document.querySelectorAll(args.dialog)]
    .filter((d) => visible(d) && !d.parentElement?.closest(args.dialog))
    .map((d) => {
      const r = d.getBoundingClientRect();
      const controls = [...d.querySelectorAll('button, input, select, a[href], [role="button"]')].filter(visible);
      return {
        label: labelOf(d).slice(0, 40),
        fits: !outside(r),
        box: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        controlsOutside: controls.filter((c) => outside(c.getBoundingClientRect()) && !inScroller(c, d)).map((c) => labelOf(c)).slice(0, 3),
      };
    });

  // The rendered size counts: a UI scaled down by a CSS transform shrinks its 12px text too.
  let textNodes = 0;
  let small = 0;
  const samples: string[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!node.textContent?.trim() || el === null || el.closest('script,style,noscript,[aria-hidden="true"]') !== null || !visible(el)) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || outside(rect)) {
      continue;
    }
    textNodes++;
    const htmlEl = el as HTMLElement;
    const scale = htmlEl.offsetHeight > 0 ? rect.height / htmlEl.offsetHeight : 1;
    const px = parseFloat(getComputedStyle(el).fontSize) * scale;
    if (px < args.minPx - 0.05) {
      small++;
      if (samples.length < 3) {
        samples.push(`${Math.round(px * 10) / 10}px «${node.textContent.trim().slice(0, 30)}»`);
      }
    }
  }

  // Rewarded buttons by words or data-rewarded; a same-row neighbour within 10% (not measured) is equal.
  const REWARDED = /\b(watch|video|ad|ads)\b|▶|📺/i;
  const unequal: string[] = [];
  let rewarded = 0;
  for (const button of document.querySelectorAll('button, [role="button"]')) {
    const hint = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('data-rewarded') !== null ? 'ad' : ''}`;
    if (!REWARDED.test(hint) || !visible(button) || button.parentElement === null) {
      continue;
    }
    rewarded++;
    const r = button.getBoundingClientRect();
    for (const other of button.parentElement.children) {
      if (other === button || !(other.matches('button, [role="button"]') && visible(other)) || REWARDED.test(other.textContent ?? '')) {
        continue;
      }
      const o = other.getBoundingClientRect();
      if (Math.min(r.width, o.width) / Math.max(r.width, o.width) < 0.9 || Math.min(r.height, o.height) / Math.max(r.height, o.height) < 0.9) {
        unequal.push(`${labelOf(button)} ${Math.round(r.width)}x${Math.round(r.height)} vs ${labelOf(other)} ${Math.round(o.width)}x${Math.round(o.height)}`);
      }
    }
  }

  // iOS hides the native scrollbar; a custom one shows up as an element named or roled scrollbar.
  const BAR = /scroll-?(bar|thumb|track)|thumb/i;
  const scrollers = [...document.querySelectorAll('body *')]
    .filter((el) => visible(el) && scrollable(el))
    .slice(0, 10)
    .map((el) => {
      const near = [...el.querySelectorAll('*'), ...(el.parentElement ? [...el.parentElement.children] : [])];
      const customBar = near.some((n) => n.getAttribute('role') === 'scrollbar' || BAR.test(String(n.className)));
      return { label: labelOf(el).slice(0, 40), customBar };
    });

  let canvasShare = 0;
  for (const canvas of document.querySelectorAll('canvas')) {
    const r = canvas.getBoundingClientRect();
    canvasShare = Math.max(canvasShare, (Math.min(r.width, vw) * Math.min(r.height, vh)) / (vw * vh));
  }
  const pageOverflow = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - vw;
  return {
    vw,
    vh,
    textNodes,
    canvasShare: Math.round(canvasShare * 100) / 100,
    pageOverflow: pageOverflow > 1 ? pageOverflow : 0,
    dialogs,
    smallText: { count: small, samples },
    rewarded,
    unequal,
    scrollers,
  };
}
