// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

export const INSTRUCTIONS =
  'Checks a built HTML5 game against CrazyGames portal rules and returns findings as JSON, instead of ' +
  'screenshots and one-off Playwright scripts. cg_build_check: size, file count, paths, foreign hosts in the ' +
  'build or zip, no browser. cg_sdk_session: plays the build in an emulated portal frame with an SDK emulator ' +
  'and reports gameplayStart/Stop pairing, a pause on every window, SDK reads repeated while idle, autosave ' +
  'every 30 s, save on hide, localStorage writes, sound during ads, rewarded cooldown and the bytes loaded ' +
  'before the first gameplayStart. cg_frame_audit: windows, text size, equal ad buttons and overflow in each ' +
  'portal frame size, from the DOM. A rule the run could not exercise comes back in unchecked with the reason; ' +
  'add steps (click, tap, press, eval, check, rewardedTwice) to reach it, and save them as cg-scenario.json in ' +
  'the game root so later calls need only the path. Build the game first: these tools read dist, not src. ' +
  'A session takes about 10 s plus idleSeconds (default 35).';
