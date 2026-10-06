// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Portal numbers, each with its source: when a game is rejected, the number has to be re-checkable.

export const MB = 1024 * 1024;

export const LIMITS = {
  // docs.crazygames.com/requirements/technical
  totalBytes: 250 * MB,
  files: 1500,
  initialBytes: 50 * MB,
  // Same page, for the mobile homepage.
  initialBytesMobile: 20 * MB,
  // Reviewer email 2026-09-30: setItem every 30 s; once a minute was rejected.
  autosaveMs: 30_000,
  // The SDK banner module refuses faster refreshes; the reviewer asked for 35 s.
  bannerMinMs: 30_000,
  // The owner's threshold for "readable at DPR 1", not a docs number.
  minTextPx: 12,
};
