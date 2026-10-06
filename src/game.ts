// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Finds the built game behind any path an agent sends: the project root, the build folder or the zip.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { InputError } from './format.js';
import { readZip } from './zip.js';

// Web export folders of the engines seen so far: Vite and friends, Godot, Construct/GDevelop.
const BUILD_DIRS = ['dist', 'build/web', 'build', 'export/web', 'export'];

export interface BuildFile {
  path: string;
  size: number;
}

export interface Build {
  kind: 'dir' | 'zip';
  // The project root when there is one; holds package.json and src for the staleness check.
  root: string;
  location: string;
  slug: string;
  files: BuildFile[];
  read(path: string): string;
  // Raw bytes for serving the game; a zip build is read from the archive.
  bytes(path: string): Buffer | null;
}

export function locateBuild(input: string): Build {
  const path = resolve(input);
  if (!existsSync(path)) {
    throw new InputError(`not found: ${path}`, 'pass the game root, its build folder or the release zip');
  }
  if (statSync(path).isFile()) {
    if (!path.toLowerCase().endsWith('.zip')) {
      throw new InputError(`not a zip: ${path}`, 'pass the game root, its build folder or the release zip');
    }
    return zipBuild(path);
  }
  // The build folder first: a Vite root has its own index.html, the source one, next to node_modules.
  for (const dir of BUILD_DIRS) {
    if (existsSync(join(path, dir, 'index.html'))) {
      return dirBuild(join(path, dir), path);
    }
  }
  if (existsSync(join(path, 'package.json'))) {
    throw new InputError(`no build in ${path}: none of ${BUILD_DIRS.join(', ')} has index.html`, 'build the game first');
  }
  if (existsSync(join(path, 'index.html'))) {
    const parent = dirname(path);
    const root = existsSync(join(parent, 'package.json')) || existsSync(join(parent, 'project.godot')) ? parent : path;
    return dirBuild(path, root);
  }
  throw new InputError(`no index.html in ${path} or in ${BUILD_DIRS.join(', ')}`, 'build the game first');
}

function slugOf(root: string): string {
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name;
    if (name) {
      return name.replace(/^@[^/]+\//, '');
    }
  }
  return basename(root).replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function dirBuild(dir: string, root: string): Build {
  const files: BuildFile[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        files.push({ path: relative(dir, full).split(sep).join('/'), size: stat.size });
      }
    }
  };
  walk(dir);
  // Exact paths only: Windows and macOS find Game.JS for game.js, the portal's CDN does not.
  const known = new Set(files.map((file) => file.path));
  return {
    kind: 'dir',
    root,
    location: dir,
    slug: slugOf(root),
    files,
    read: (path) => readFileSync(join(dir, path), 'utf8'),
    bytes: (path) => (known.has(path) ? readFileSync(join(dir, path)) : null),
  };
}

function zipBuild(path: string): Build {
  const zip = readZip(path);
  const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));
  // release/<game>.zip sits one level below the project; a zip next to package.json, none.
  const parent = dirname(path);
  const root = existsSync(join(parent, 'package.json')) || !existsSync(join(dirname(parent), 'package.json')) ? parent : dirname(parent);
  return {
    kind: 'zip',
    root,
    location: path,
    slug: slugOf(root),
    files: zip.entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => ({ path: entry.name, size: entry.size })),
    read: (name) => {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new Error(`no ${name} in the zip`);
      }
      return zip.data(entry).toString('utf8');
    },
    bytes: (name) => {
      const entry = byName.get(name);
      return entry === undefined ? null : zip.data(entry);
    },
  };
}

// Newest source change after the build means the agent is checking yesterday's game.
export function staleHours(build: Build): number | null {
  const src = join(build.root, 'src');
  if (build.kind !== 'dir' || !existsSync(src)) {
    return null;
  }
  let newest = 0;
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
      }
    }
  };
  walk(src);
  const built = statSync(join(build.location, 'index.html')).mtimeMs;
  return newest > built ? Math.round(((newest - built) / 3_600_000) * 10) / 10 : null;
}
