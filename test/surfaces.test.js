// V3: one feature set everywhere. The registry in src/surfaces.js is checked against the real CLI, MCP tools and UI
// routes, docs/SURFACES.md must match it, and the routes the UI gained work like the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const { ACTIONS, CLI_INTERNAL, na, surfacesMarkdown } = await import('../src/surfaces.js');
const { createUiServer } = await import('../src/ui/server.js');
const L = await import('../src/lessons.js');

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const BIN = read('bin/conductor.js'), MCP = read('src/mcp.js'), SERVER = read('src/ui/server.js');
const mcpTools = [...MCP.matchAll(/name: '(conductor_\w+)'/g)].map((m) => m[1]);
const routes = [...SERVER.matchAll(/case '((?:GET|POST|PUT|DELETE) \/api\/[\w/-]+)'/g)].map((m) => m[1]);
const cliWord = (cli) => (cli.match(/^conductor ([a-z][\w-]*)/) || [])[1];

test('every action is in every surface, or says why not', () => {
  const ids = new Set();
  for (const a of ACTIONS) {
    assert.ok(!ids.has(a.id), `duplicate ${a.id}`); ids.add(a.id);
    for (const k of ['cli', 'mcp', 'ui']) {
      const v = a[k];
      assert.ok(typeof v === 'string' ? v.length : na(v)?.length > 10, `${a.id}: ${k} needs a value or { na: 'a reason' }`);
    }
  }
});

test('the registry matches the code: CLI commands, MCP tools and UI routes exist, and none is left out', () => {
  const commands = JSON.parse(BIN.match(/const COMMANDS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  for (const a of ACTIONS) {
    const w = cliWord(a.cli);
    if (w) assert.ok(new RegExp(`case '${w}'`).test(BIN) || commands.includes(w), `${a.id}: the CLI has no "${w}" command`);
    if (typeof a.mcp === 'string') assert.ok(mcpTools.includes(a.mcp), `${a.id}: no MCP tool ${a.mcp}`);
    if (typeof a.ui === 'string') assert.ok(routes.includes(a.ui), `${a.id}: no UI route ${a.ui}`);
  }
  for (const t of mcpTools) assert.ok(ACTIONS.some((a) => a.mcp === t || (t === 'conductor_retry' && a.id === 'retry')), `MCP tool ${t} is not in src/surfaces.js`);
  const cliWords = new Set(ACTIONS.flatMap((a) => [...a.cli.matchAll(/conductor ([a-z][\w-]*)/g)].map((m) => m[1])));
  for (const c of commands) assert.ok(cliWords.has(c) || CLI_INTERNAL.includes(c), `CLI command "${c}" is not in src/surfaces.js`);
  // every UI route belongs to an action: its first path segment matches an action's route
  const seg = (r) => r.split(' ')[1].split('/')[2];
  const covered = new Set(ACTIONS.filter((a) => typeof a.ui === 'string').map((a) => seg(a.ui)));
  const helpers = ['config', 'state', 'init', 'test', 'route-templates', 'models', 'secrets', 'cooldowns', 'providers', 'provider-models', 'local', 'skills', 'runs', 'run']; // setup screens and their sub-steps
  for (const r of routes) assert.ok(covered.has(seg(r)) || helpers.includes(seg(r)), `UI route ${r} is not in src/surfaces.js`);
});

test('docs/SURFACES.md is generated from the registry (node scripts/gen-surfaces.mjs)', () => {
  assert.equal(read('docs/SURFACES.md'), surfacesMarkdown());
});

test('the UI does what the CLI does: stats, lessons (add, promote, remove), rules, guard', async () => {
  const { dir } = makeRepo();
  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    const st = await call('GET', '/api/stats');
    assert.equal(st.json.quality.writeTasks, 0);
    assert.equal((await call('POST', '/api/lessons/add', {})).status, 400, 'a lesson needs text');
    let ls = (await call('POST', '/api/lessons/add', { text: 'Keep dates in UTC', files: ['src/'] })).json.lessons;
    assert.equal(ls[0].text, 'Keep dates in UTC');
    for (let i = 0; i < 2; i++) L.addLesson(dir, { source: 'manual', text: 'Keep dates in UTC', files: ['src/'] });
    ls = (await call('GET', '/api/lessons')).json.lessons;
    assert.equal(ls[0].promote, true, 'seen 3 times: offered as a rule');
    const pr = await call('POST', '/api/lessons/promote', { id: ls[0].id });
    assert.match(pr.json.bullet, /Keep dates in UTC/);
    assert.match(fs.readFileSync(`${dir}/AGENTS.md`, 'utf8'), /Keep dates in UTC/);
    assert.equal((await call('POST', '/api/lessons/remove', { id: ls[0].id })).json.lessons.length, 0);
    assert.equal((await call('POST', '/api/lessons/remove', { id: 'nope' })).status, 404);
    assert.deepEqual((await call('GET', '/api/rules')).json.rules, []);
    let g = (await call('GET', '/api/guard')).json;
    assert.deepEqual([g.supported, g.on], [true, false]);
    g = (await call('POST', '/api/guard', { on: true })).json;
    assert.equal(g.on, true);
    assert.ok(fs.existsSync(`${dir}/.claude/settings.local.json`));
    g = (await call('POST', '/api/guard', { on: false })).json;
    assert.equal(g.on, false);
  } finally { ui.server.closeAllConnections?.(); ui.server.close(); }
});
