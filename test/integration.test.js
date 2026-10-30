// init, MCP server and UI server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';

const home = isolateHome();
const { initProject } = await import('../src/init.js');
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

test('init (gemini-cli) writes TOML commands and gemini MCP settings', () => {
  const { dir } = makeRepo();
  initProject(dir, { controller: 'gemini-cli' });
  const toml = fs.readFileSync(path.join(dir, '.gemini/commands/conduct-plan.toml'), 'utf8');
  assert.match(toml, /^description = "/);
  assert.match(toml, /\{\{args\}\}/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.gemini/settings.json'), 'utf8')).mcpServers.conductor);
  assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /conductor:start/);
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
  assert.ok(r.notes.some((n) => n.includes('mcp_servers.conductor')));
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
  const init = await m.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'conductor-ai');
  m.notify('notifications/initialized');
  const disc = await m.request('server/discover', {});
  assert.ok(disc.result.supportedVersions.includes('2026-07-28'));
  const list = await m.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['conductor_run', 'conductor_batch', 'conductor_status', 'conductor_verify']);
  const st = await m.request('tools/call', { name: 'conductor_status', arguments: {} });
  assert.match(st.result.content[0].text, /roles \(fallback order/);
  const bad = await m.request('tools/call', { name: 'conductor_run', arguments: { role: 'build', task: 'x' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /protected branch/);
  const unk = await m.request('nope/method', {});
  assert.equal(unk.error.code, -32601);
  m.close();
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
    const eff = st.effective; eff.roles.build = ['codex-cli', 'gemini-cli'];
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project', effective: eff }) });
    assert.equal(put.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.conductor/config.json'), 'utf8'));
    assert.deepEqual(saved.roles, { build: ['codex-cli', 'gemini-cli'] });
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
