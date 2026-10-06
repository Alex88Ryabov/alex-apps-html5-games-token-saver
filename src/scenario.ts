// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// cg-scenario.json in the game root, written once; arguments of a call win over the file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { InputError } from './format.js';
import type { Step } from './steps.js';

export const SCENARIO_FILE = 'cg-scenario.json';

export const stepSchema = z.union([
  z.object({ click: z.string() }).strict(),
  z.object({ tap: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]) }).strict(),
  z.object({ press: z.string(), holdMs: z.number().int().positive().optional() }).strict(),
  z.object({ wait: z.number().int().min(0).max(120_000) }).strict(),
  z.object({ waitFor: z.string(), timeoutMs: z.number().int().positive().max(120_000).optional() }).strict(),
  z.object({ eval: z.string() }).strict(),
  z.object({ check: z.string() }).strict(),
  z.object({ rewardedTwice: z.string() }).strict(),
]);

const fileSchema = z
  .object({
    query: z.string().optional(),
    init: z.string().optional(),
    dialog: z.string().optional(),
    steps: z.array(stepSchema).optional(),
  })
  .strict();

// Checked here, not in the tool schema: the union in JSON Schema made tools/list 5436 chars, not 3402.
export function parseSteps(steps: unknown[] | undefined): Step[] | undefined {
  if (steps === undefined) {
    return undefined;
  }
  const parsed = z.array(stepSchema).safeParse(steps);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InputError(`bad step ${issue?.path.join('.')}: ${JSON.stringify(steps[Number(issue?.path[0])] ?? null)}`, 'one key per step: click, tap, press(+holdMs), wait, waitFor, eval, check, rewardedTwice');
  }
  return parsed.data as Step[];
}

export interface Scenario {
  query?: string;
  init?: string;
  dialog?: string;
  steps: Step[];
  from?: string;
}

export function loadScenario(root: string, args: Omit<Scenario, 'steps' | 'from'> & { steps?: Step[] }): Scenario {
  const path = join(root, SCENARIO_FILE);
  let file: z.infer<typeof fileSchema> = {};
  if (existsSync(path)) {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      throw new InputError(`${SCENARIO_FILE}: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`, 'see the steps parameter of the tool for the format');
    }
    file = parsed.data;
  }
  return {
    query: args.query ?? file.query,
    init: args.init ?? file.init,
    dialog: args.dialog ?? file.dialog,
    steps: (args.steps ?? file.steps ?? []) as Step[],
    from: args.steps === undefined && file.steps !== undefined ? SCENARIO_FILE : undefined,
  };
}
