// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Opens a build as the portal shows it, answered from disk by page.route: no server, no port.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, BrowserType, Frame, Page } from 'playwright-core';
import { InputError } from './format.js';
import type { Build } from './game.js';
import type { CgEvent, CgWindow } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');
const PROBE = readFileSync(join(assets, 'probe.js'), 'utf8');
const STUB = readFileSync(join(assets, 'stub.js'), 'utf8');

const TOP = 'https://www.crazygames.com/game/';
// Permissive: the portal's real list is unknown, and an invented violation would read as the game's bug.
const FRAME_ALLOW = 'autoplay; fullscreen; clipboard-read; clipboard-write; gamepad; accelerometer; gyroscope; magnetometer; web-share; xr-spatial-tracking';
const GAME_HOST = 'https://games.crazygames.com/en_US/';
// A ceiling, not measured: a 3D game under SwiftShader boots in seconds, a stuck one never.
const BOOT_TIMEOUT_MS = 45_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.pck': 'application/octet-stream',
};

export type Engine = 'chromium' | 'webkit';

// Playwright from the game's node_modules: its e2e installed the browsers for that version.
export async function loadBrowserType(root: string, engine: Engine): Promise<BrowserType> {
  for (const base of [join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
    const require = createRequire(base);
    for (const name of ['playwright-core', 'playwright', '@playwright/test']) {
      try {
        const module = (await import(pathToFileURL(require.resolve(name)).href)) as Record<string, BrowserType> & { default?: Record<string, BrowserType> };
        const type = module[engine] ?? module.default?.[engine];
        if (type) {
          return type;
        }
      } catch {
        // Not installed here; the next candidate decides.
      }
    }
  }
  throw new InputError('Playwright not found in the game or next to html5-games-token-saver', 'npm i -D @playwright/test && npx playwright install chromium');
}

export async function launch(root: string, engine: Engine): Promise<Browser> {
  const type = await loadBrowserType(root, engine);
  // SwiftShader gives WebGL without a GPU; autoplay lets the audio graph run for the mute check.
  const args =
    engine === 'chromium'
      ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
      : [];
  try {
    return await type.launch({ args });
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new InputError(`cannot launch ${engine}: ${message}`, `npx playwright install ${engine} in the game folder`);
  }
}

export interface OpenOptions {
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  mobile?: boolean;
  // Appended to the game URL, e.g. ?debug=1.
  query?: string;
  // Runs in the game frame before its scripts: a debug flag, a seeded save.
  init?: string;
  dialog?: string;
  sdk?: Record<string, unknown>;
}

export interface OpenGame {
  context: BrowserContext;
  page: Page;
  frame: Frame;
  // Bytes answered from the build with their wall-clock time, for the initial download.
  served: Array<{ at: number; bytes: number }>;
  external: Set<string>;
  missing: Set<string>;
  consoleErrors: string[];
  timeOrigin: number;
  log(): Promise<CgEvent[]>;
}

export async function openGame(browser: Browser, build: Build, options: OpenOptions): Promise<OpenGame> {
  if (build.bytes('index.html') === null) {
    throw new InputError(`no index.html at the top of ${build.location}`, 'the portal opens index.html from the root of the zip');
  }
  const context = await browser.newContext({
    // A service worker would fetch past page.route, straight to the network.
    serviceWorkers: 'block',
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    isMobile: options.mobile ?? false,
    hasTouch: options.mobile ?? false,
    locale: 'en-US',
  });
  const served: OpenGame['served'] = [];
  const external = new Set<string>();
  const missing = new Set<string>();
  const consoleErrors: string[] = [];
  const slug = encodeURIComponent(build.slug);
  const base = `${GAME_HOST}${slug}/`;
  const query = (options.query ? (options.query.startsWith('?') ? options.query : `?${options.query}`) : '').replace(/"/g, '&quot;');

  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(TOP)) {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe src="${base}index.html${query}" allow="${FRAME_ALLOW}"></iframe></body></html>`,
      });
      return;
    }
    if (url.startsWith('https://sdk.crazygames.com/')) {
      await route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: STUB });
      return;
    }
    if (url.startsWith(base)) {
      let rel = new URL(url).pathname.slice(new URL(base).pathname.length) || 'index.html';
      try {
        rel = decodeURIComponent(rel);
      } catch {
        // A lone % is a 404 on the portal too; the raw path is reported as missing.
      }
      const body = build.bytes(rel.endsWith('/') ? `${rel}index.html` : rel);
      if (body === null) {
        missing.add(rel);
        await route.fulfill({ status: 404, body: 'not found' });
        return;
      }
      served.push({ at: Date.now(), bytes: body.length });
      await route.fulfill({ body, contentType: TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream' });
      return;
    }
    // An absolute path leaves the game folder: on the portal that is a 404 too.
    if (url.startsWith('https://games.crazygames.com/')) {
      missing.add(new URL(url).pathname);
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    // Foreign hosts get an empty 204, not an abort: a failed fetch makes telemetry log errors of its own.
    if (url.startsWith('http')) {
      external.add(new URL(url).host);
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' });
      return;
    }
    await route.abort();
  });

  const cfg = { dialog: options.dialog, sdk: options.sdk ?? {} };
  await context.addInitScript({ content: `window.__cgCfg = ${JSON.stringify(cfg)};\n${PROBE}` });
  // A script of its own: a syntax error in it shows as a console error instead of killing the probe.
  if (options.init) {
    await context.addInitScript({ content: `if (location.hostname === 'games.crazygames.com') {\n${options.init}\n}` });
  }

  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && consoleErrors.length < 20) {
      consoleErrors.push(message.text().slice(0, 160));
    }
  });
  // Not 'load': the parent waits for the iframe's load, which a heavy game delays past the timeout.
  await page.goto(`${TOP}${slug}`, { waitUntil: 'commit' });
  const frame = await gameFrame(page);
  const timeOrigin = await frame.evaluate(() => performance.timeOrigin);
  return {
    context,
    page,
    frame,
    served,
    external,
    missing,
    consoleErrors,
    timeOrigin,
    log: () => frame.evaluate(() => (window as unknown as CgWindow).__cg?.log.slice() ?? []),
  };
}

async function gameFrame(page: Page): Promise<Frame> {
  // A ceiling, not measured: the iframe appears within a second when index.html is in place.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().startsWith(GAME_HOST));
    if (frame) {
      await frame.waitForLoadState('domcontentloaded');
      return frame;
    }
    await page.waitForTimeout(50);
  }
  throw new InputError('the game frame did not open', 'is index.html at the root of the build?');
}

// Boot ends at loadingStop or the first gameplayStart; a game sending neither is measured after the ceiling.
export async function waitBoot(game: OpenGame): Promise<boolean> {
  try {
    await game.frame.waitForFunction(
      () => (window as unknown as CgWindow).__cg?.log.some((e) => e.k === 'call' && (e.n === 'game.loadingStop' || e.n === 'game.gameplayStart')) ?? false,
      undefined,
      { timeout: BOOT_TIMEOUT_MS, polling: 200 },
    );
    return true;
  } catch {
    return false;
  }
}
