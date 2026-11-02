// Each CLI worker runs with its own permission rules, and never sees secrets meant for other providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

const home = isolateHome();
fs.writeFileSync(path.join(home, 'secrets.env'), 'SCRUB_TEST_SECRET=s1\nOPENCODE_API_KEY=k1\n');
process.env.SHELL_TEST_VAR = 'mine';
const LOG = path.join(fs.realpathSync(home), 'env.json');
fakeBins({
  opencode: `fs.writeFileSync(${JSON.stringify(LOG)}, JSON.stringify({ args, env: process.env })); console.log('## RESULT: DONE padding padding padding');`,
});

const { loadConfig, readOnlyEnforced, providerPermissions } = await import('../src/config.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { CLI_PRESETS } = await import('../src/presets.js');

const seen = () => JSON.parse(fs.readFileSync(LOG, 'utf8'));

test('opencode: read mode denies edits and mutating commands; secrets for other providers are removed', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const s = await dispatch(loadConfig(dir), { role: 'ask', task: 'what is here?', chain: ['opencode'] });
  assert.equal(s.winner, 'opencode');
  const { args, env } = seen();
  assert.ok(!args.includes('--auto'));
  assert.ok(args.includes('--standalone'), 'the background service would ignore the per-run rules');
  const perm = JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(perm.edit, 'deny');
  assert.equal(perm.external_directory, 'deny');
  assert.equal(perm.bash['*'], 'deny');
  assert.equal(perm.bash['git diff*'], 'allow');
  assert.equal(env.SCRUB_TEST_SECRET, undefined, 'a secret from secrets.env is not passed to the worker');
  assert.equal(env.OPENCODE_API_KEY, 'k1', 'the key this CLI needs is passed');
  assert.equal(env.SHELL_TEST_VAR, 'mine', "the user's own environment is kept");
  assert.ok(!s.warnings.some((w) => w.includes('cannot be held to read-only')));
});

test('opencode: write mode auto-approves inside the project but denies git push and outside folders', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  await dispatch(loadConfig(dir), { role: 'docs', task: 'write docs', chain: ['opencode'] });
  const { args, env } = seen();
  assert.ok(args.includes('--auto'));
  const perm = JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(perm.external_directory, 'deny');
  assert.equal(perm.bash['git push*'], 'deny');
  assert.equal(perm.bash['sudo*'], 'deny');
  assert.equal(perm.edit, undefined);
});

test('every built-in CLI preset describes its permissions; none bypasses them', () => {
  for (const [name, p] of Object.entries(CLI_PRESETS)) {
    assert.ok(p.permissions?.write && p.permissions?.read, `${name} documents its permissions`);
    for (const a of [...p.write, ...(p.read || [])]) assert.doesNotMatch(a, /dangerously|yolo|bypass/i, `${name} must not bypass permissions`);
  }
  assert.ok(!CLI_PRESETS.gemini, 'Gemini CLI preset is removed');
  assert.equal(readOnlyEnforced({ type: 'cli', preset: 'kimi' }), false);
  assert.equal(readOnlyEnforced({ type: 'cli', preset: 'codex' }), true);
  assert.equal(readOnlyEnforced({ type: 'cli', preset: 'codex', read: ['exec'] }), false, 'overridden read args are not trusted');
  assert.equal(readOnlyEnforced({ type: 'openai' }), true);
  assert.equal(providerPermissions({ type: 'openai' }), null);
});

test('configs that still name Gemini CLI load without it', () => {
  const { dir } = makeRepo();
  fs.mkdirSync(path.join(dir, '.conductor'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.conductor/config.json'), JSON.stringify({
    controller: 'gemini-cli',
    providers: { 'gemini-cli': { type: 'cli', preset: 'gemini', enabled: true } },
    roles: { build: ['gemini-cli', 'codex-cli'] },
  }));
  const cfg = loadConfig(dir);
  assert.equal(cfg.providers['gemini-cli'], undefined);
  assert.deepEqual(cfg.roles.build, ['codex-cli']);
  assert.equal(cfg.controller, 'antigravity');
  assert.equal(cfg.notices.length, 2);
});
