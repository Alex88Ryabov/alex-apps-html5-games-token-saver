#!/usr/bin/env node
// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// CrazyGames portal checks as an MCP server: three tools, dense JSON answers.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DEFAULT_SIZES, runAudit } from './audit.js';
import { checkBuild } from './build-check.js';
import { InputError, json, toolError, type ToolResult } from './format.js';
import { locateBuild } from './game.js';
import { INSTRUCTIONS } from './instructions.js';
import { LIMITS } from './rules.js';
import { loadScenario, parseSteps } from './scenario.js';
import { runSession } from './session.js';

const server = new McpServer({ name: 'html5-games-token-saver', version: '0.1.0' }, { instructions: INSTRUCTIONS });

function failure(error: unknown): ToolResult {
  if (error instanceof InputError) {
    return toolError({ error: error.message, hint: error.hint });
  }
  return toolError({ error: error instanceof Error ? error.message.split('\n')[0] : String(error) });
}

const path = z.string().describe('Game root, its build folder (dist, build/web) or the release zip');
const scenario = {
  steps: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Run after boot, in the game frame: {click:selector} {tap:[x,y] viewport 0..1} {press:key,holdMs?} {wait:ms} {waitFor:selector,timeoutMs?} {eval:js} {check:label} {rewardedTwice:selector}. Default: steps of cg-scenario.json',
    ),
  query: z.string().optional().describe('Appended to the game URL, e.g. ?debug=1'),
  init: z.string().optional().describe('JS run in the game frame before its scripts, e.g. a debug flag'),
  dialog: z.string().optional().describe('CSS selector of a window; default role=dialog, dialog[open], aria-modal'),
  engine: z.enum(['chromium', 'webkit']).default('chromium'),
};

server.registerTool(
  'cg_build_check',
  {
    description: 'Static portal checks of a built game or its zip: size, file count, index.html at root, absolute paths, resources from foreign hosts, zip slashes, SDK version. No browser, milliseconds.',
    inputSchema: { path },
  },
  async (args) => {
    try {
      return json(checkBuild(locateBuild(args.path)));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'cg_sdk_session',
  {
    description: 'Plays the build in an emulated CrazyGames frame with an SDK emulator, then idles and hides the tab. Verdicts for gameplay pairs, pause on windows, SDK reads while idle, autosave, save on hide, localStorage, sound during ads, rewarded cooldown, initial download, console errors.',
    inputSchema: {
      path,
      ...scenario,
      idleSeconds: z.number().int().min(0).max(300).default(35).describe('No-input stretch in play; autosave needs >= 32'),
      adOutcome: z.enum(['finished', 'unfilled', 'adblock', 'other']).default('finished').describe('How the emulated ad ends'),
    },
  },
  async (args) => {
    try {
      const build = locateBuild(args.path);
      const s = loadScenario(build.root, { ...args, steps: parseSteps(args.steps) });
      const verdict = await runSession(build, {
        steps: s.steps,
        query: s.query,
        init: s.init,
        dialog: s.dialog,
        idleSeconds: args.idleSeconds,
        engine: args.engine,
        sdk: { adOutcome: args.adOutcome },
      });
      return json({ scenarioFrom: s.from, ...verdict });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'cg_frame_audit',
  {
    description: 'Measures the DOM in each portal frame size at boot, at every check step and at the end: windows inside the frame, reachable controls, rendered text size, rewarded vs no-ad button size, page overflow, scrollers without a custom bar on phones.',
    inputSchema: {
      path,
      ...scenario,
      sizes: z.array(z.string()).default(DEFAULT_SIZES).describe('WxH, m suffix for a touch phone'),
      minTextPx: z.number().default(LIMITS.minTextPx),
      shots: z.boolean().default(false).describe('Save a PNG of each failing point to the temp folder and return the paths'),
    },
  },
  async (args) => {
    try {
      const build = locateBuild(args.path);
      const s = loadScenario(build.root, { ...args, steps: parseSteps(args.steps) });
      const result = await runAudit(build, {
        steps: s.steps,
        query: s.query,
        init: s.init,
        dialog: s.dialog,
        sizes: args.sizes,
        minTextPx: args.minTextPx,
        engine: args.engine,
        shots: args.shots,
      });
      return json({ scenarioFrom: s.from, ...result });
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
