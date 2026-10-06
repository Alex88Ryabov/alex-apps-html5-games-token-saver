// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Static checks of a built game against the portal limits: no browser, milliseconds.

import { human, mb } from './format.js';
import { staleHours, type Build } from './game.js';
import { LIMITS } from './rules.js';
import type { Finding } from './types.js';

const TEXT = /\.(html?|css|m?js)$/i;
// Only forms that fetch: a bare URL in a bundle is an error-message link, an <a href> is navigation.
const LOADS = /\bsrc\s*=\s*["']https?:\/\/[^"']+|<link\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)"']+|import\(\s*["']https?:\/\/[^"']+|fetch\(\s*["']https?:\/\/[^"']+/gi;
const LINKS = /<a\b[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+/gi;
const HOST = /https?:\/\/(?:[\w-]+@)?([a-z0-9.-]+)/i;
const SDK = /sdk\.crazygames\.com\/crazygames-sdk-v(\d)/;
const SAMPLE = 3;

export function checkBuild(build: Build): Record<string, unknown> {
  const fail: Finding[] = [];
  const warn: Finding[] = [];
  const total = build.files.reduce((sum, file) => sum + file.size, 0);
  const paths = new Set(build.files.map((file) => file.path));

  if (!paths.has('index.html')) {
    fail.push({ rule: 'indexAtRoot', got: `no index.html at the top of the ${build.kind}`, want: 'index.html in the root, not in a subfolder' });
  }
  const backslashed = build.files.filter((file) => file.path.includes('\\')).map((file) => file.path);
  if (backslashed.length > 0) {
    fail.push({ rule: 'zipSlashes', got: `${backslashed.length} entries with backslashes`, want: 'forward slashes (Compress-Archive writes backslashes)', files: backslashed.slice(0, SAMPLE) });
  }
  if (total > LIMITS.totalBytes) {
    fail.push({ rule: 'totalSize', got: `${mb(total)} MB`, want: `<= ${mb(LIMITS.totalBytes)} MB` });
  }
  if (build.files.length > LIMITS.files) {
    fail.push({ rule: 'fileCount', got: String(build.files.length), want: `<= ${LIMITS.files}` });
  }
  // Without a measured gameplayStart the portal counts the whole build as the initial download.
  if (total > LIMITS.initialBytes) {
    warn.push({ rule: 'initialDownload', got: `whole build ${mb(total)} MB`, want: `<= 50 MB before the first gameplayStart; measure with cg_sdk_session` });
  } else if (total > LIMITS.initialBytesMobile) {
    warn.push({ rule: 'initialDownloadMobile', got: `whole build ${mb(total)} MB`, want: '<= 20 MB before the first gameplayStart for the mobile homepage; measure with cg_sdk_session' });
  }
  const debugFiles = build.files.map((file) => file.path).filter((path) => /\.map$|preview-crazygames\.html$|\.DS_Store$|Thumbs\.db$/i.test(path));
  if (debugFiles.length > 0) {
    warn.push({ rule: 'debugFiles', got: `${debugFiles.length} sourcemaps or preview files`, files: debugFiles.slice(0, SAMPLE) });
  }

  const absolute: string[] = [];
  const foreign = new Map<string, string[]>();
  const links = new Set<string>();
  const sdkVersions = new Set<string>();
  let userSelectNone = false;
  let localStorageFiles = 0;
  for (const file of build.files) {
    if (!TEXT.test(file.path)) {
      continue;
    }
    const text = build.read(file.path);
    if (/\.html?$/i.test(file.path) && /\b(?:src|href)\s*=\s*["']\/(?!\/)/.test(text)) {
      absolute.push(file.path);
    } else if (/\.css$/i.test(file.path) && /url\(\s*["']?\/(?!\/)/.test(text)) {
      absolute.push(file.path);
    }
    for (const match of text.matchAll(LOADS)) {
      const host = HOST.exec(match[0])?.[1]?.toLowerCase();
      if (host !== undefined && host !== 'sdk.crazygames.com') {
        foreign.set(host, [...(foreign.get(host) ?? []), file.path]);
      }
    }
    if (/\.html?$/i.test(file.path)) {
      for (const match of text.matchAll(LINKS)) {
        links.add(HOST.exec(match[0])?.[1]?.toLowerCase() ?? match[0]);
      }
    }
    const sdk = SDK.exec(text);
    if (sdk?.[1] !== undefined) {
      sdkVersions.add(`v${sdk[1]}`);
    }
    if (/user-select\s*:\s*none/i.test(text)) {
      userSelectNone = true;
    }
    if (/\.m?js$/i.test(file.path) && text.includes('localStorage')) {
      localStorageFiles++;
    }
  }
  if (absolute.length > 0) {
    fail.push({ rule: 'absolutePaths', got: 'src/href or url() starting with /', want: 'relative paths: the game is served from a subfolder', files: absolute.slice(0, SAMPLE) });
  }
  for (const [host, files] of foreign) {
    fail.push({ rule: 'foreignLoads', got: `loads from ${host}`, want: 'every resource inside the build', files: [...new Set(files)].slice(0, SAMPLE) });
  }
  if (links.size > 0) {
    warn.push({ rule: 'externalLinks', got: `links to ${[...links].slice(0, 5).join(', ')} in html`, want: 'no external links in play; store and community links only in the menu' });
  }
  if (sdkVersions.size === 0) {
    warn.push({ rule: 'sdkScript', got: 'no sdk.crazygames.com script reference', want: 'SDK v3 for gameplay events, saves and ads (an engine plugin may load it another way)' });
  } else if (![...sdkVersions].every((version) => version === 'v3')) {
    warn.push({ rule: 'sdkScript', got: [...sdkVersions].join(','), want: 'v3' });
  }
  // Without it a phone lays the page out 980 px wide and scales it down: every text shrinks.
  if (paths.has('index.html') && !/<meta[^>]+name=["']viewport["']/i.test(build.read('index.html'))) {
    warn.push({ rule: 'viewportMeta', got: 'no <meta name="viewport"> in index.html', want: 'width=device-width, initial-scale=1' });
  }
  if (!userSelectNone) {
    warn.push({ rule: 'userSelect', got: 'no user-select: none in html/css', want: 'selection gestures off for mobile' });
  }

  const stale = staleHours(build);
  if (stale !== null) {
    warn.push({ rule: 'staleBuild', got: `src is ${stale} h newer than the build`, want: 'rebuild before checking' });
  }
  const biggest = [...build.files].sort((a, b) => b.size - a.size).slice(0, 5).map((file) => `${file.path} ${human(file.size)}`);
  return {
    build: { kind: build.kind, at: build.location, files: build.files.length, mb: mb(total), sdk: [...sdkVersions].join(',') || null },
    ok: fail.length === 0,
    fail,
    warn,
    biggest,
    // Runtime truth (what is written where) is cg_sdk_session's job; this is only a lead.
    jsFilesMentioningLocalStorage: localStorageFiles || null,
  };
}
