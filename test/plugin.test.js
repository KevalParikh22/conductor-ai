// The Claude Code / Antigravity plugin in this repo stays in sync with the command templates and the package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome } from './helpers.js';

isolateHome();
const { commandSkills } = await import('../src/init.js');
const root = new URL('..', import.meta.url).pathname;
const json = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

test('plugin skills match the command templates (run: node scripts/gen-plugin.mjs)', () => {
  const want = commandSkills({ plugin: true });
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), want.map((s) => s.name));
  for (const s of want) assert.equal(fs.readFileSync(path.join(root, 'skills', s.name, 'SKILL.md'), 'utf8'), s.content, s.name);
  for (const s of want) {
    const head = s.content.split('---')[1];
    for (const line of head.split('\n').filter(Boolean)) {
      const v = line.replace(/^[\w-]+: /, '');
      assert.ok(/^(true|false|[\w-]+)$/.test(v) || (() => { try { return typeof JSON.parse(v) === 'string'; } catch { return false; } })(), `${s.name}: "${line}" must be valid YAML (quoted when it has brackets)`);
    }
  }
});

test('manifests: names, version from package.json, both MCP files run conductor mcp, files are packaged', () => {
  const pkg = json('package.json');
  for (const f of ['.claude-plugin/plugin.json', '.antigravity-plugin/plugin.json']) {
    const m = json(f);
    assert.equal(m.name, 'conductor-ai', f);
    assert.equal(m.version, pkg.version, `${f} version (run: node scripts/gen-plugin.mjs)`);
  }
  assert.ok(fs.existsSync(path.join(root, json('.claude-plugin/plugin.json').icon)));
  assert.ok(fs.existsSync(path.join(root, json('.antigravity-plugin/plugin.json').logo)));
  const mk = json('.claude-plugin/marketplace.json');
  assert.deepEqual(mk.plugins.map((p) => [p.name, p.source]), [['conductor-ai', './']]);
  for (const f of ['.mcp.json', 'mcp_config.json']) assert.deepEqual(json(f).mcpServers.conductor, { command: 'conductor', args: ['mcp'] }, f);
  const claudeHook = json('hooks/hooks.json').hooks.SessionStart[0].hooks[0].command;
  assert.equal(json('hooks.json')['conductor-check'].SessionStart[0].command, claudeHook, 'Claude and Antigravity hooks run the same check');
  for (const f of ['skills', 'hooks', 'hooks.json', '.claude-plugin', '.antigravity-plugin', '.mcp.json', 'mcp_config.json', 'assets']) assert.ok(pkg.files.includes(f), `package.json files includes ${f}`);
});
