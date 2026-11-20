// init, MCP server and UI server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';
import { fileURLToPath } from 'node:url';

const home = isolateHome();
const { initProject, codexHasConductor } = await import('../src/init.js');
const { createUiServer } = await import('../src/ui/server.js');
const BIN = fileURLToPath(new URL('../bin/conductor-ai.js', import.meta.url));

test('init (claude-code) adds files, preserves user content, and is idempotent', () => {
  const { dir } = makeRepo({ files: { 'CLAUDE.md': '# My rules\nkeep me\n', 'AGENTS.md': '# Existing agents file\n' } });
  initProject(dir, { controller: 'claude-code' });
  const claude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /keep me/);
  assert.match(claude, /@AGENTS\.md/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /# Existing agents file[\s\S]*conductor-ai:rules:start/);
  assert.ok(fs.existsSync(path.join(dir, '.claude/commands/conduct-run.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers['conductor-ai'], { command: 'conductor-ai', args: ['mcp'] });
  assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /@\.\/AGENTS\.md/);
  const second = initProject(dir, { controller: 'claude-code' });
  assert.ok(second.lines.every((l) => /kept/.test(l)), 'second run changes nothing:\n' + second.lines.join('\n'));
  assert.equal((fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').match(/conductor-ai:start/g) || []).length, 1);
});

test('init writes .vscode/mcp.json when asked or when .vscode/ exists, and keeps other servers', () => {
  const plain = makeRepo().dir;
  initProject(plain, { controller: 'claude-code' });
  assert.ok(!fs.existsSync(path.join(plain, '.vscode/mcp.json')), 'no .vscode folder, not asked: nothing written');
  initProject(plain, { controller: 'claude-code', vscode: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plain, '.vscode/mcp.json'), 'utf8')).servers['conductor-ai'], { type: 'stdio', command: 'conductor-ai', args: ['mcp'] });
  const { dir } = makeRepo({ files: { '.vscode/mcp.json': JSON.stringify({ servers: { other: { type: 'stdio', command: 'x' } } }) } });
  initProject(dir, { controller: 'opencode' });
  const servers = JSON.parse(fs.readFileSync(path.join(dir, '.vscode/mcp.json'), 'utf8')).servers;
  assert.deepEqual(Object.keys(servers), ['other', 'conductor-ai']);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.agents/mcp_config.json'), 'utf8')).mcpServers['conductor-ai'], { command: 'conductor-ai', args: ['mcp'] });
  const gemini = fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8');
  assert.match(gemini, /Antigravity CLI only/);
  assert.match(gemini, /Workers: ignore this section/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.conductor-ai/config.json'), 'utf8')).controller, 'antigravity');
});

test('init (codex-cli) keeps the controller section conditional in AGENTS.md', () => {
  const { dir } = makeRepo();
  const r = initProject(dir, { controller: 'codex-cli' });
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Workers: ignore this section/);
  assert.ok(r.notes.some((n) => n.includes('codex mcp add conductor-ai -- conductor-ai mcp')) || codexHasConductor(), 'register hint unless already registered');
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/conduct-plan/SKILL.md')), 'Codex reads skills from .agents/skills');
  assert.ok(!fs.existsSync(path.join(dir, '.conductor-ai/commands')), 'no prompts in a folder no tool reads');
});

test('init (opencode) writes skills where OpenCode reads them, plus its MCP entry', () => {
  const { dir } = makeRepo();
  initProject(dir, { controller: 'opencode' });
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/conduct-run/SKILL.md')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).mcp['conductor-ai'].command.join(' '), 'conductor-ai mcp');
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
  assert.deepEqual(list.result.tools.map((t) => t.name), ['conductor_ai_run', 'conductor_ai_batch', 'conductor_ai_retry', 'conductor_ai_diff', 'conductor_ai_plan_check', 'conductor_ai_lessons', 'conductor_ai_stats', 'conductor_ai_doctor', 'conductor_ai_import', 'conductor_ai_rules', 'conductor_ai_route', 'conductor_ai_runs', 'conductor_ai_skills', 'conductor_ai_status', 'conductor_ai_verify']);
  assert.ok(list.result.tools.every((t) => t.inputSchema.properties.project), 'every tool takes a project path');
  const st = await m.request('tools/call', { name: 'conductor_ai_status', arguments: {} });
  assert.match(st.result.content[0].text, /roles \(fallback order/);
  const bad = await m.request('tools/call', { name: 'conductor_ai_run', arguments: { role: 'build', task: 'x' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /protected branch/);
  // V3: the same actions as the CLI
  const sts = await m.request('tools/call', { name: 'conductor_ai_stats', arguments: {} });
  assert.match(sts.result.content[0].text, /write tasks[\s\S]*Failures in the last 30 days/);
  const doc = await m.request('tools/call', { name: 'conductor_ai_doctor', arguments: {} });
  assert.match(doc.result.content[0].text, /problem|look good/);
  const rules = await m.request('tools/call', { name: 'conductor_ai_rules', arguments: {} });
  assert.match(rules.result.content[0].text, /No project rules yet/);
  const added = await m.request('tools/call', { name: 'conductor_ai_lessons', arguments: { text: 'Keep dates in UTC' } });
  const lid = added.result.content[0].text.match(/^added (\w+)/)[1];
  const pro = await m.request('tools/call', { name: 'conductor_ai_lessons', arguments: { promote: lid } });
  assert.match(pro.result.content[0].text, /added to AGENTS\.md: - Keep dates in UTC/);
  const rm = await m.request('tools/call', { name: 'conductor_ai_lessons', arguments: { remove: lid } });
  assert.match(rm.result.content[0].text, new RegExp(`removed ${lid}`));
  // run reports as resources: none yet in a fresh project; the URI template is listed; an unknown run is an error
  assert.deepEqual((await m.request('resources/list', {})).result.resources, []);
  assert.equal((await m.request('resources/templates/list', {})).result.resourceTemplates[0].uriTemplate, 'conductor-ai://runs/{id}');
  assert.equal((await m.request('resources/read', { uri: 'conductor-ai://runs/nope' })).error.code, -32002);
  const unk = await m.request('nope/method', {});
  assert.equal(unk.error.code, -32601);
  // the plan check tool: a vague task is reported, with exactly what's missing
  fs.mkdirSync(path.join(dir, 'docs/plan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/plan/v.md'), '# Plan\n\n## Tasks\n\n### T1: thing\n- **role:** build\n- **acceptance:**\n  - [ ] works\n');
  const pc = await m.request('tools/call', { name: 'conductor_ai_plan_check', arguments: { plan: 'docs/plan/v.md' } });
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
    assert.match((await call('conductor_ai_route', { task: 'fix a typo', files: ['a.md'], role: 'docs' })).content[0].text, /^role docs · /);
    assert.match((await call('conductor_ai_diff', {})).content[0].text, /new\.js/);
    assert.match((await call('conductor_ai_runs', {})).content[0].text, /No runs yet|run +result/);
    assert.match((await call('conductor_ai_skills', {})).content[0].text, /No skills yet|✓|○/);
    const r = await call('conductor_ai_retry', { task_id: 'T9', note: 'x' });
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
    assert.equal(fs.realpathSync.native(st.root), fs.realpathSync.native(dir));
    const eff = st.effective; eff.roles.build = ['codex-cli', 'opencode'];
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', effective: eff }) });
    assert.equal(put.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.conductor-ai/config.json'), 'utf8'));
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
    const wn = await (await fetch(`${base}/api/whatsnew`, { headers: { 'x-conductor-token': 'tok' } })).json();
    assert.ok(wn.sections.length >= 1 && wn.sections.length <= 2, 'the newest CHANGELOG sections');
    assert.ok(wn.sections.flatMap((s) => s.items).length <= 12);
    assert.ok(wn.sections.every((s) => s.items.every((i) => !i.includes('**'))), 'plain text');
  } finally { ui.server.close(); }
});

test('whatsNew: newest sections, top-level bullets cut to their first sentence, no file → empty', async () => {
  const { whatsNew } = await import('../src/ui/server.js');
  const f = path.join(home, 'CHANGELOG-test.md');
  fs.writeFileSync(f, '# Changelog\n\n## 1.2.0\n\n- **Faster.** Much more text here.\n  - nested detail\n- A [link](https://x) works. More.\n\n## 1.1.0\n\n- Old thing.\n\n## 1.0.0\n\n- Oldest.\n');
  assert.deepEqual(whatsNew(f), { sections: [{ heading: '1.2.0', items: ['Faster.', 'A link works.'] }, { heading: '1.1.0', items: ['Old thing.'] }] });
  assert.deepEqual(whatsNew(path.join(home, 'nope.md')), { sections: [] });
});

test('init moves an MCP entry an older init wrote (conductor-ai mcp) to conductor-ai; one you changed is kept', () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { conductor: { command: 'conductor', args: ['mcp'] }, other: { command: 'x' } } }));
  initProject(dir, { controller: 'claude-code' });
  const d = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(d.mcpServers['conductor-ai'], { command: 'conductor-ai', args: ['mcp'] });
  assert.deepEqual(d.mcpServers.other, { command: 'x' }, 'other servers untouched');
  const own = makeRepo().dir;
  fs.writeFileSync(path.join(own, '.mcp.json'), JSON.stringify({ mcpServers: { conductor: { command: '/opt/bin/conductor', args: ['mcp'] } } }));
  initProject(own, { controller: 'claude-code' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(own, '.mcp.json'), 'utf8')).mcpServers.conductor.command, '/opt/bin/conductor', 'your own entry is kept');
});
