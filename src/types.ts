// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

export interface Finding {
  rule: string;
  got: string;
  want?: string;
  files?: string[];
}

export interface Unchecked {
  rule: string;
  why: string;
}

// One probe log entry: name, kind (call, read, missing, event, probe, ui, mark, error), page time.
export interface CgEvent {
  n: string;
  k: string;
  t: number;
  a?: unknown[];
}

export interface CgWindow {
  __cg?: { log: CgEvent[]; rec(n: string, k: string, a?: unknown[]): void };
}
