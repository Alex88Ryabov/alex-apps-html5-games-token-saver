// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

export interface ToolResult {
  // Index signature is required by the SDK result type.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// Answers are dense JSON with no markdown: every extra character lands in the agent context.
export function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(compact(payload)) }] };
}

// A real failure is flagged with isError, or the agent reads the breakage report as data.
export function toolError(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

// null, undefined and empty arrays cost tokens and say nothing; false stays, it is an answer.
export function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => compact(item)) as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || (Array.isArray(item) && item.length === 0)) {
      continue;
    }
    result[key] = compact(item);
  }
  return result as T;
}

export function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function human(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${mb(bytes)}MB`;
}

export class InputError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}
