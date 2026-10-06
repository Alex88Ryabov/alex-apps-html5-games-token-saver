// Static checks, the zip reader and finding the build behind a path.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { judge, parseSize } from '../dist/audit.js';
import { checkBuild } from '../dist/build-check.js';
import { locateBuild } from '../dist/game.js';
import { loadScenario } from '../dist/scenario.js';
import { readZip } from '../dist/zip.js';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'mini-game');

function tempGame(files) {
  const root = mkdtempSync(join(tmpdir(), 'cg-test-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// A zip by hand, stored or deflated: the reader does not verify CRCs.
function zipOf(entries, deflate = false) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('the fixture build is clean and its scenario is picked up', () => {
  const build = locateBuild(fixture);
  assert.equal(build.location, join(fixture, 'dist'));
  const result = checkBuild(build);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warn, []);
  assert.equal(loadScenario(build.root, {}).from, 'cg-scenario.json');
});

test('a Vite root with a source index.html resolves to dist, never to the root itself', () => {
  const root = tempGame({ 'package.json': '{"name":"@x/my-game"}', 'index.html': '<script src="/src/main.ts"></script>', 'dist/index.html': '<meta name="viewport">' });
  const build = locateBuild(root);
  assert.equal(build.location, join(root, 'dist'));
  assert.equal(build.slug, 'my-game');
  const unbuilt = tempGame({ 'package.json': '{}', 'index.html': '<p>' });
  assert.throws(() => locateBuild(unbuilt), /no build/);
});

test('absolute paths, foreign loads and a missing viewport meta are found', () => {
  const root = tempGame({
    'package.json': '{}',
    'dist/index.html': '<link href="/assets/a.css"><script src="https://cdn.example.com/x.js"></script>',
    'dist/assets/a.css': 'body{background:url(/bg.png)}',
    'dist/assets/b.js': 'fetch("https://api.example.org/score"); const doc = "https://react.dev/errors";',
  });
  const result = checkBuild(locateBuild(root));
  const fails = result.fail.map((f) => `${f.rule}:${f.got}`);
  assert.ok(fails.some((f) => f.startsWith('absolutePaths')));
  assert.ok(fails.includes('foreignLoads:loads from cdn.example.com'));
  assert.ok(fails.includes('foreignLoads:loads from api.example.org'));
  assert.ok(!fails.some((f) => f.includes('react.dev')), 'a bare URL in a bundle is not a load');
  assert.ok(result.warn.some((w) => w.rule === 'viewportMeta'));
});

test('a zip is read by its central directory; backslashes and a nested index fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-zip-'));
  const good = join(dir, 'good.zip');
  writeFileSync(good, zipOf([['index.html', '<meta name="viewport"><style>*{user-select:none}</style><script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>'], ['assets/a.js', 'x']]));
  assert.deepEqual(readZip(good).entries.map((e) => e.name), ['index.html', 'assets/a.js']);
  const result = checkBuild(locateBuild(good));
  assert.equal(result.ok, true);
  assert.equal(result.build.sdk, 'v3');
  const bad = join(dir, 'bad.zip');
  writeFileSync(bad, zipOf([['game\\index.html', 'x']]));
  const rules = checkBuild(locateBuild(bad)).fail.map((f) => f.rule);
  assert.deepEqual(rules.sort(), ['indexAtRoot', 'zipSlashes']);
});

test('sizes parse with the phone suffix and reject garbage', () => {
  assert.deepEqual(parseSize('390x664m'), { width: 390, height: 664, mobile: true });
  assert.throws(() => parseSize('big'), /bad size/);
});

const measured = (over = {}) => ({
  vw: 800,
  vh: 450,
  textNodes: 10,
  canvasShare: 0.5,
  pageOverflow: 0,
  dialogs: [],
  smallText: { count: 0, samples: [] },
  rewarded: 0,
  unequal: [],
  scrollers: [],
  ...over,
});

test('the same finding at many points is one entry with its places', () => {
  const unequal = ['rewarded 140x44 vs skip 80x30'];
  const points = ['boot', 'shop', 'end'].map((point) => ({ size: '800x450', mobile: false, point, m: measured({ rewarded: 1, unequal }) }));
  const result = judge(points, 12);
  assert.equal(result.fail.length, 1);
  assert.equal(result.fail[0].got, 'rewarded 140x44 vs skip 80x30 @800x450 boot,shop,end');
});

test('a canvas-only interface is unchecked, not clean', () => {
  const result = judge([{ size: '800x450', mobile: false, point: 'boot', m: measured({ textNodes: 0, canvasShare: 1 }) }], 12);
  assert.ok(result.unchecked.some((u) => u.rule === 'layout'));
});

test('a scroller without a custom bar warns on phones only', () => {
  const m = measured({ scrollers: [{ label: 'list', customBar: false }] });
  assert.equal(judge([{ size: '800x450', mobile: false, point: 'boot', m }], 12).warn.length, 0);
  assert.equal(judge([{ size: '390x664m', mobile: true, point: 'boot', m }], 12).warn[0]?.rule, 'iosScrollbar');
});

test('a deflated zip reads back byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-zip-'));
  const path = join(dir, 'deflate.zip');
  const text = '<meta name="viewport">'.repeat(200);
  writeFileSync(path, zipOf([['index.html', text]], true));
  const zip = readZip(path);
  assert.equal(zip.data(zip.entries[0]).toString('utf8'), text);
  assert.equal(locateBuild(path).bytes('index.html').toString('utf8'), text);
});

test('build files are served by exact path only, as the portal CDN does', () => {
  const root = tempGame({ 'package.json': '{}', 'dist/index.html': 'x', 'dist/Game.js': 'y' });
  const build = locateBuild(root);
  assert.equal(build.bytes('Game.js')?.toString(), 'y');
  assert.equal(build.bytes('game.js'), null);
  assert.equal(build.bytes('../package.json'), null);
});

test('an <a href> to another site warns as a link, it is not a resource load', () => {
  const root = tempGame({ 'package.json': '{}', 'dist/index.html': '<meta name="viewport"><a href="https://discord.gg/x">Discord</a>' });
  const result = checkBuild(locateBuild(root));
  assert.ok(!result.fail.some((f) => f.rule === 'foreignLoads'));
  assert.equal(result.warn.find((w) => w.rule === 'externalLinks')?.got, 'links to discord.gg in html');
});
