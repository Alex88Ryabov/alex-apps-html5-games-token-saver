# html5-games-token-saver

MCP server that checks a built HTML5 game against the CrazyGames portal rules and answers with dense JSON:
a list of failures, warnings and rules it could not exercise, instead of screenshots and one-off Playwright
scripts in the agent context.

## Install

```
claude mcp add html5-games-token-saver -- npx -y @alex-apps/html5-games-token-saver
```

The game needs Playwright with Chromium (`npm i -D @playwright/test && npx playwright install chromium`); the server
takes it from the game's `node_modules`. Build the game before a check: the tools read `dist`, not `src`.

## Tools

| Tool | What it does | Time |
|---|---|---|
| `cg_build_check` | Size, file count, `index.html` at root, absolute paths, resources from foreign hosts, zip slashes, SDK version, viewport meta, `user-select`, stale build. Dist folder or release zip. | ms |
| `cg_sdk_session` | Plays the build in an emulated portal frame with an SDK v3 emulator, idles, hides the tab. Verdicts below. | ~10 s + idle |
| `cg_frame_audit` | DOM in each frame size at boot, at each `check` step, at the end: windows inside the frame, reachable controls, rendered text size, rewarded vs no-ad button size, page overflow, scrollers without a custom bar on phones. | seconds per size |

`cg_sdk_session` rules: first `gameplayStart`, bytes loaded before it, loading order, start/stop pairs, a pause on
every window and a resume on close, an SDK member hit repeatedly (a render loop or a per-second timer), SDK reads
with no input, autosave every 30 s, save on hide, `localStorage` writes on the portal, sound during an ad, rewarded
cooldown, banner refresh, console errors, 404s inside the frame, requests to foreign hosts, SDK members the emulator
does not implement.

A rule the run could not reach comes back in `unchecked` with the reason; it is never reported as a pass.

## How it emulates the portal

No server and no port. `page.route` answers `www.crazygames.com/game/<slug>` with a page holding an iframe of
`games.crazygames.com/en_US/<slug>/index.html`, serves the build from disk (folder or zip) under that path, and
serves the SDK emulator at `sdk.crazygames.com`. A host check or an iframe check in the game sees the portal.
Foreign requests get an empty 204 and are listed. A probe injected before the game scripts records SDK calls and
property reads, `localStorage` writes, windows opening and closing (`role=dialog`, `dialog[open]`, `aria-modal`), and
the audio level tapped in front of `AudioContext.destination`, so the mute check works for any engine.

Playwright is taken from the game's `node_modules` (its e2e already installs it and its browsers), then from next to
this package.

## Scenario

The only game-specific part. `cg-scenario.json` in the game root, or the same fields as tool arguments:

```json
{
  "init": "window.__mtDebug = true",
  "query": "?debug=1",
  "dialog": "[role=dialog]",
  "steps": [
    { "waitFor": "data-testid=settings-open" },
    { "click": "data-testid=settings-open" },
    { "check": "settings" },
    { "tap": [0.005, 0.005] },
    { "press": "Escape" },
    { "eval": "window.__mt.requestMidgame()" },
    { "rewardedTwice": "[data-testid=bonuses-modal] button:has-text(\"Watch\")" },
    { "wait": 2500 }
  ]
}
```

Selectors are Playwright selectors inside the game frame; taps are viewport fractions, so one scenario serves every
frame size and canvas games. A click is a player's click at the element's centre (game buttons pulse and never look
stable to Playwright); on phone sizes clicks and taps are touches. `waitFor` takes `timeoutMs` for slow 3D boots.
`check` holds the screen 4.5 s in a session (a per-second timer shows) and measures in the audit, after finite CSS
animations end. `rewardedTwice` watches a rewarded ad, then clicks the same button again at once.

Windows and their `gameplayStop` are matched by order, not by clock: a 3D game under SwiftShader sent the stop
10 s after the click and showed the window 3.5 s later.

## Verified on

- A fixture game (`fixtures/mini-game`) where each reviewer rule is broken by a query flag: the clean run passes
  every rule, each flag fails its rule (`npm run smoke`).
- Muscle Titans 1.7.0 and 2.0.1, built from git before the fixes for two reviewer emails: the session finds
  `inviteLink` called every second, the save copy in `localStorage`, autosave once a minute, unlimited rewarded
  ads, `isUserAccountAvailable` read every second; the audit finds the missing iOS scrollbar. 2.0.2, the fixed
  version, passes all of them. Not checkable by the tool: the midgame countdown text and the banner suggestion.
- Blocky Barber and TowerDefence (three.js; TowerDefence renders over a second per frame under SwiftShader):
  scenarios open every window and both pass; their ads are off before Full Launch, so the ad rules stay unchecked.

## Limits

- Chromium under SwiftShader: WebGL works, timings are slower than a real GPU.
- The portal's real iframe `allow` list is not known; the emulated one is permissive.
- `textSize` uses 12 px, the owner's threshold, not a docs number.
- Custom iOS scrollbars are recognised by class names and roles; a miss is a warning.
- A canvas-drawn interface cannot be measured from the DOM; the audit says so in `unchecked`.
- Unity and Godot export plugins are assumed to call the same JS SDK; not verified.

## Commands

```
npm test       build + unit tests (node:test)
npm run smoke  real MCP client over stdio against the fixture game
node tools/run.mjs build|session|audit <path> [...]  one tool without a client
```
