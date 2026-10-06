// Runs one tool without an MCP client, printing the JSON answer:
//   node tools/run.mjs build <path>
//   node tools/run.mjs session <path> [query] [idleSeconds] [steps.json]
//   node tools/run.mjs audit <path> [query] [steps.json] [sizes,comma,separated]
import { readFileSync } from 'node:fs';
import { runAudit, DEFAULT_SIZES } from '../dist/audit.js';
import { checkBuild } from '../dist/build-check.js';
import { locateBuild } from '../dist/game.js';
import { loadScenario } from '../dist/scenario.js';
import { runSession } from '../dist/session.js';

const [tool, path, ...rest] = process.argv.slice(2);
const build = locateBuild(path);
const readSteps = (file) => (file ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

if (tool === 'build') {
  console.log(JSON.stringify(checkBuild(build)));
} else if (tool === 'session') {
  const [query, idle = '35', stepsFile] = rest;
  const s = loadScenario(build.root, { query: query || undefined, steps: readSteps(stepsFile) });
  console.log(JSON.stringify(await runSession(build, { ...s, idleSeconds: Number(idle), engine: 'chromium' })));
} else if (tool === 'audit') {
  const [query, stepsFile, sizes] = rest;
  const s = loadScenario(build.root, { query: query || undefined, steps: readSteps(stepsFile) });
  console.log(JSON.stringify(await runAudit(build, { ...s, sizes: sizes ? sizes.split(',') : DEFAULT_SIZES, minTextPx: 12, engine: 'chromium', shots: false })));
} else {
  console.error('tool: build | session | audit');
  process.exit(1);
}
