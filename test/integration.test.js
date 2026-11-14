// init, MCP server and UI server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';

const home = isolateHome();
const { initProject, codexHasConductor } = await import('../src/init.js');
const { createUiServer } = await import('../src/ui/server.js');
const BIN = new URL('../bin/conductor.js', import.meta.url).pathname;

test('init (claude-code) adds files, preserves user content, and is idempotent', () => {
  const { dir } = makeRepo({ files: { 'CLAUDE.md': '# My rules\nkeep me\n', 'AGENTS.md': '# Existing agents file\n' } });
  initProject(dir, { controller: 'claude-code' });
  const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /keep me/);
  assert.match(claude, /@AGENTS\.md/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /# Existing agents file[\s\S]*conductor:rules:start/);
  assert.ok(fs.existsSync(path.join(dir, '.claude/commands/conduct-run.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.conductor, { command: 'conductor', args: ['mcp'] });
  assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /@\.\/AGENTS\.md/);
  const second = initProject(dir, { controller: 'claude-code' });
  assert.ok(second.lines.every((l) => /kept/.test(l)), 'second run changes nothing:\n' + second.lines.join('\n'));
  assert.equal((fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').match(/conductor:start/g) || []).length, 1);
});

test('init writes .vscode/mcp.json when asked or when .vscode/ exists, and keeps other servers', () => {
  const plain = makeRepo().dir;
  initProject(plain, { controller: 'claude-code' });
  assert.ok(!fs.existsSync(path.join(plain, '.vscode/mcp.json')), 'no .vscode folder, not asked: nothing written');
  initProject(plain, { controller: 'claude-code', vscode: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plain, '.vscode/mcp.json'), 'utf8')).servers.conductor, { type: 'stdio', command: 'conductor', args: ['mcp'] });
  const { dir } = makeRepo({ files: { '.vscode/mcp.json': JSON.stringify({ servers: { other: { type: 'stdio', command: 'x' } } }) } });
  initProject(dir, { controller: 'opencode' });
  const servers = JSON.parse(fs.readFileSync(path.join(dir, '.vscode/mcp.json'), 'utf8')).servers;
  assert.deepEqual(Object.keys(servers), ['other', 'conductor']);
});

test('init refuses the retired gemini-cli controller', () => {
  const { dir } = makeRepo();
  assert.throws(() => initProject(dir, { controller: 'gemini-cli' }), /unknown controller "gemini-cli"/);
});

test('init (antigravity) writes skills, MCP config and a controller-only GEMINI.md block', () => {
  const { dir } = makeRepo();
  initProject(dir, { controller: 'antigravity' });
  const skill = fs.readFileSync(path.join(dir, '.agents/skills/conduct-plan/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: conduct-plan\ndescription: "/);
  assert.doesNotMatch(skill, /\$ARGUMENTS/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.agents/mcp_config.json'), 'utf8')).mcpServers.conductor, { command: 'conductor', args: ['mcp'] });
  const gemini = fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8');
  assert.match(gemini, /Antigravity CLI only/);
  assert.match(gemini, /Workers: ignore this section/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.conductor/config.json'), 'utf8')).controller, 'antigravity');
});

test('init (codex-cli) keeps the controller section conditional in AGENTS.md', () => {
  const { dir } = makeRepo();
  const r = initProject(dir, { controller: 'codex-cli' });
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Workers: ignore this section/);
  assert.ok(r.notes.some((n) => n.includes('codex mcp add conductor -- conductor mcp')) || codexHasConductor(), 'register hint unless already registered');
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/conduct-plan/SKILL.md')), 'Codex reads skills from .agents/skills');
  assert.ok(!fs.existsSync(path.join(dir, '.conductor/commands')), 'no prompts in a folder no tool reads');
});

test('init (opencode) writes skills where OpenCode reads them, plus its MCP entry', () => {
  const { dir } = makeRepo();
  initProject(dir, { controller: 'opencode' });
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/conduct-run/SKILL.md')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).mcp.conductor.command.join(' '), 'conductor mcp');
});

test('codexHasConductor reads ~/.codex/config.toml', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-')), 'config.toml');
  assert.equal(codexHasConductor(f), false);
  fs.writeFileSync(f, 'model = "x"\n\n[mcp_servers.conductor]\ncommand = "conductor"\nargs = ["mcp"]\n');
  assert.equal(codexHasConductor(f), true);
});

function mcpSession(cwd) {
  const env = { ...process.env, CONDUCTOR_HOME: home }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(msg.id)?.(msg); }
  });
  let id = 0;
  return {
    request: (method, params) => new Promise((r) => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); }),
    notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'),
    close: () => child.stdin.end(),
  };
}

test('MCP server: handshake, tools/list, status and usage errors', async () => {
  const { dir } = makeRepo({ branch: null }); // on main: build must be refused
  const m = mcpSession(dir);
  try {
  const init = await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'conductor-ai');
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} }, 'tools and run reports as resources');
  m.notify('notifications/initialized');
  const disc = await m.request('server/discover', {});
  assert.ok(disc.result.supportedVersions.includes('2026-07-28'));
  const list = await m.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['conductor_run', 'conductor_batch', 'conductor_retry', 'conductor_diff', 'conductor_plan_check', 'conductor_lessons', 'conductor_stats', 'conductor_doctor', 'conductor_import', 'conductor_rules', 'conductor_route', 'conductor_runs', 'conductor_skills', 'conductor_status', 'conductor_verify']);
  assert.ok(list.result.tools.every((t) => t.inputSchema.properties.project), 'every tool takes a project path');
  const st = await m.request('tools/call', { name: 'conductor_status', arguments: {} });
  assert.match(st.result.content[0].text, /roles \(fallback order/);
  const bad = await m.request('tools/call', { name: 'conductor_run', arguments: { role: 'build', task: 'x' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /protected branch/);
  // V3: the same actions as the CLI
  const sts = await m.request('tools/call', { name: 'conductor_stats', arguments: {} });
  assert.match(sts.result.content[0].text, /write tasks[\s\S]*Failures in the last 30 days/);
  const doc = await m.request('tools/call', { name: 'conductor_doctor', arguments: {} });
  assert.match(doc.result.content[0].text, /problem|look good/);
  const rules = await m.request('tools/call', { name: 'conductor_rules', arguments: {} });
  assert.match(rules.result.content[0].text, /No project rules yet/);
  const added = await m.request('tools/call', { name: 'conductor_lessons', arguments: { text: 'Keep dates in UTC' } });
  const lid = added.result.content[0].text.match(/^added (\w+)/)[1];
  const pro = await m.request('tools/call', { name: 'conductor_lessons', arguments: { promote: lid } });
  assert.match(pro.result.content[0].text, /added to AGENTS\.md: - Keep dates in UTC/);
  const rm = await m.request('tools/call', { name: 'conductor_lessons', arguments: { remove: lid } });
  assert.match(rm.result.content[0].text, new RegExp(`removed ${lid}`));
  // run reports as resources: none yet in a fresh project; the URI template is listed; an unknown run is an error
  assert.deepEqual((await m.request('resources/list', {})).result.resources, []);
  assert.equal((await m.request('resources/templates/list', {})).result.resourceTemplates[0].uriTemplate, 'conductor://runs/{id}');
  assert.equal((await m.request('resources/read', { uri: 'conductor://runs/nope' })).error.code, -32002);
  const unk = await m.request('nope/method', {});
  assert.equal(unk.error.code, -32601);
  // the plan check tool: a vague task is reported, with exactly what's missing
  fs.mkdirSync(path.join(dir, 'docs/plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/plan/v.md'), '# Plan\n\n## Tasks\n\n### T1: thing\n- **role:** build\n- **acceptance:**\n  - [ ] works\n');
  const pc = await m.request('tools/call', { name: 'conductor_plan_check', arguments: { plan: 'docs/plan/v.md' } });
  assert.equal(pc.result.isError, true);
  assert.match(pc.result.content[0].text, /✗ T1: thing[\s\S]*no files[\s\S]*too vague to check: "works"/);
  } finally { m.close(); } // a failed assertion must not leave the server running (the suite would hang)
});

test('MCP server: route, diff, runs, skills and retry tools; project path from another folder', async () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'new.js'), 'export const x = 1;\n');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-elsewhere-'));
  const m = mcpSession(elsewhere); // started outside the project, like a globally registered server
  try {
    await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const call = async (name, args) => (await m.request('tools/call', { name, arguments: { project: dir, ...args } })).result;
    assert.match((await call('conductor_route', { task: 'fix a typo', files: ['a.md'], role: 'docs' })).content[0].text, /^role docs · /);
    assert.match((await call('conductor_diff', {})).content[0].text, /new\.js/);
    assert.match((await call('conductor_runs', {})).content[0].text, /No runs yet|run +result/);
    assert.match((await call('conductor_skills', {})).content[0].text, /No skills yet|✓|○/);
    const r = await call('conductor_retry', { task_id: 'T9', note: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no record of a worktree task "T9"/);
  } finally { m.close(); }
});

test('UI server: host + token checks, config save writes a minimal diff, secrets file is private', async () => {
  const { dir } = makeRepo();
  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const st = await (await fetch(`${base}/api/state`, { headers: { 'x-conductor-token': 'tok' } })).json();
    assert.equal(st.root, fs.realpathSync(dir));
    const eff = st.effective; eff.roles.build = ['codex-cli', 'opencode'];
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', effective: eff }) });
    assert.equal(put.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.conductor/config.json'), 'utf8'));
    assert.deepEqual(saved.roles, { build: ['codex-cli', 'opencode'] });
    assert.equal(saved.providers, undefined, 'unchanged providers are not written');
    eff.roles.build = ['does-not-exist'];
    const badPut = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', effective: eff }) });
    assert.equal(badPut.status, 400);
    const sec = await fetch(`${base}/api/secrets`, { method: 'PUT', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ updates: { OPENROUTER_API_KEY: 'sk-or-123' } }) });
    assert.equal(sec.status, 200);
    const file = path.join(home, 'secrets.env');
    assert.match(fs.readFileSync(file, 'utf8'), /OPENROUTER_API_KEY=sk-or-123/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const evil = await new Promise((resolve) => {
      import('node:http').then(({ request }) => {
        const r = request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example', 'x-conductor-token': 'tok' } }, (res) => resolve(res.statusCode));
        r.end();
      });
    });
    assert.equal(evil, 403);
  } finally { ui.server.close(); }
});
