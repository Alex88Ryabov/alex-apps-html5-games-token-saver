// End-to-end check with a real MCP client over stdio: the three tools on the fixture game, a clean
// run and a broken one, plus what the tool list costs every session.
//   node tools/mcp-smoke.mjs
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const game = resolve('fixtures/mini-game');
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')] }));

const { tools } = await client.listTools();
const described = tools.reduce((sum, tool) => sum + (tool.description ?? '').length, 0);
const withParams = JSON.stringify(tools.map((t) => [t.description, t.inputSchema])).length;
console.log(`tools: ${tools.map((t) => t.name).join(', ')}; descriptions ${described} chars, with schemas ${withParams}; instructions ${client.getInstructions()?.length ?? 0}`);

let failed = 0;
async function call(name, args, expect) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  const body = JSON.parse(text);
  const ok = expect(body) && !result.isError;
  failed += ok ? 0 : 1;
  console.log(`${ok ? 'ok ' : 'BAD'} ${name} ${JSON.stringify(args).slice(0, 60)} → ${text.length} chars, ${Date.now() - started} ms`);
  if (!ok) {
    console.log(text.slice(0, 600));
  }
}

await call('cg_build_check', { path: game }, (b) => b.ok === true);
await call('cg_sdk_session', { path: game, idleSeconds: 0 }, (b) => b.ok === true && b.scenarioFrom === 'cg-scenario.json' && b.passed.includes('rewardedCooldown'));
await call('cg_sdk_session', { path: game, idleSeconds: 0, query: '?nopause&loud&nocooldown' }, (b) =>
  ['pauseOnDialog', 'adMuted', 'rewardedCooldown'].every((rule) => b.fail.some((f) => f.rule === rule)),
);
await call('cg_frame_audit', { path: game, sizes: ['800x450', '390x664m'] }, (b) => b.ok === true);
await call('cg_frame_audit', { path: game, sizes: ['800x450'], query: '?small&tall&unequal' }, (b) =>
  ['dialogFits', 'textSize', 'equalButtons'].every((rule) => b.fail.some((f) => f.rule === rule)),
);
for (const [name, args] of [
  ['cg_build_check', { path: resolve('no-such-game') }],
  ['cg_sdk_session', { path: game, steps: [{ clik: '#play' }] }],
]) {
  const result = await client.callTool({ name, arguments: args });
  failed += result.isError ? 0 : 1;
  console.log(`${result.isError ? 'ok ' : 'BAD'} error path → ${result.content[0].text}`);
}

await client.close();
process.exit(failed === 0 ? 0 : 1);
