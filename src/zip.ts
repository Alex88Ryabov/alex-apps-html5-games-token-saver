// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// A zip read through its central directory, with zlib's raw inflate and no dependency.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { InputError } from './format.js';

export interface ZipEntry {
  name: string;
  size: number;
  method: number;
  offset: number;
  compressedSize: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DEFLATE = 8;

export function readZip(path: string): { entries: ZipEntry[]; data(entry: ZipEntry): Buffer } {
  const buf = readFileSync(path);
  // The end record sits in the last 64 KB + 22 bytes (the comment is at most 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('not a zip: no end of central directory');
  }
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) {
    throw new InputError('zip64 archive is not supported', 'the portal limit is 250 MB; pack with a plain zip');
  }
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== CENTRAL) {
      throw new Error('broken zip: bad central directory record');
    }
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    entries.push({
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return {
    entries,
    data(entry) {
      if (buf.readUInt32LE(entry.offset) !== LOCAL) {
        throw new Error(`broken zip: bad local header for ${entry.name}`);
      }
      const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
      const raw = buf.subarray(start, start + entry.compressedSize);
      if (entry.method !== 0 && entry.method !== DEFLATE) {
        throw new InputError(`${entry.name}: compression method ${entry.method}`, 'only stored and deflate, as browsers and the portal unpacker read them');
      }
      return entry.method === 0 ? raw : inflateRawSync(raw);
    },
  };
}
