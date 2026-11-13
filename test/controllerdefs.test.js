// V6: controllers as data. The registry drives rules, reviewer, commands, MCP and guard files; a new controller that
// reads the same formats is a data entry; docs are generated from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';

const home = isolateHome();
const { CONTROLLERS } = await import('../src/presets.js');
const { controllerErrors, controllersMarkdown, allControllers, syncControllerFiles } = await import('../src/controllers.js');
const { BASE_ENTRIES, CREATED_FILES } = await import('../src/localfiles.js');
const { GUARD_SUPPORTED } = await import('../src/guard.js');
const BIN = new URL('../bin/conductor.js', import.meta.url).pathname;
const cli = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CONDUCTOR_HOME: home, CODEX_HOME: path.join(home, 'nocodex') } });

test('every built-in controller entry is valid, and docs/CONTROLLERS.md is generated from the registry', () => {
  for (const [n, d] of Object.entries(CONTROLLERS)) assert.deepEqual(controllerErrors(n, d), [], n);
  assert.equal(fs.readFileSync(new URL('../docs/CONTROLLERS.md', import.meta.url), 'utf8'), controllersMarkdown());
  assert.deepEqual(GUARD_SUPPORTED, { 'claude-code': '.claude/settings.local.json', antigravity: '.agents/hooks.json' }, 'guard support comes from the entries');
});

test('every file conductor generates for a built-in controller is kept out of git (no surprise files in your commits)', () => {
  const match = (p) => [...BASE_ENTRIES, ...CREATED_FILES].some((e) => {
    const re = new RegExp(`^${e.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\/$/, '(/.*)?')}$`);
    return re.test(p) || re.test(`${p}/`);
  });
  for (const [n, d] of Object.entries(CONTROLLERS)) {
    const files = [d.reviewer?.file, d.rules?.dir && `${d.rules.dir}/conductor-x.md`, d.commands?.as === 'commands' ? `${d.commands.dir}/conduct-run.md` : `${d.commands.dir}/conduct-run/`, d.mcp?.file].filter(Boolean);
    for (const f of files) assert.ok(match(f), `${n}: ${f} is not in the git-exclude lists (src/localfiles.js)`);
  }
});

test('bad entries are caught: unknown formats, absolute or escaping paths', () => {
  const ok = { ...CONTROLLERS['codex-cli'], label: 'X' };
  assert.deepEqual(controllerErrors('copilot', ok), []);
  assert.match(controllerErrors('copilot', { ...ok, rules: { dir: '.x', format: 'yaml' } })[0], /rules: \{ dir, format: claude \| agy \}/);
  assert.match(controllerErrors('copilot', { ...ok, reviewer: { file: '/etc/x', format: 'claude' } })[0], /reviewer/);
  assert.match(controllerErrors('copilot', { ...ok, mcp: { file: '../x.json', format: 'mcpServers' } })[0], /mcp/);
  assert.match(controllerErrors('copilot', { ...ok, hooks: { file: '.x/h.json', format: 'bash' } })[0], /hooks/);
  assert.match(controllerErrors('Bad Name', ok)[0], /name/);
});

test('a new controller is a data entry: add --like, init writes its files, doctor checks it', () => {
  const { dir } = makeRepo();
  let r = cli(dir, 'controller', 'add', 'copilot', '--like', 'codex-cli', '--label', 'Copilot CLI');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added controller "copilot" \(global config\), reading the same formats as codex-cli/);
  assert.equal(cli(dir, 'controller', 'add', 'copilot', '--like', 'codex-cli').status, 2, 'no duplicates');
  assert.match(cli(dir, 'controller', 'list').stdout, /copilot +Copilot CLI .*\[yours\]/);
  assert.ok(allControllers(dir).copilot, 'read from the config');

  r = cli(dir, 'init', '--controller', 'copilot');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /controller: Copilot CLI/);
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/conduct-run/SKILL.md')));
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /controller instructions \(Copilot CLI only\)/);
  assert.ok(fs.existsSync(path.join(dir, '.codex/agents/conductor-reviewer.toml')));
  assert.ok(!/✗ (controllers\.|controller:)/.test(cli(dir, 'doctor').stdout));

  // a broken entry: check fails, doctor reports it
  const cfgFile = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.controllers.copilot.rules = { dir: '.github/rules', format: 'yaml' };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  r = cli(dir, 'controller', 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ copilot\n {4}- rules:/);
  assert.match(cli(dir, 'doctor').stdout, /controllers\.copilot: rules:/);
  assert.deepEqual(syncControllerFiles(dir, 'nope'), [], 'an unknown controller writes nothing');
});
