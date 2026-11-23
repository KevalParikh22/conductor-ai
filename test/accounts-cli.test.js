// `conductor-ai accounts` and the account-aware `cooldown` and status, run as the real CLI against fake `codex`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateHome, fakeBins } from './helpers.js';

const home = isolateHome();
fakeBins({
  codex: `if (args[0]==='login' && args[1]==='status') process.exit(fs.existsSync(require('path').join(process.env.CODEX_HOME||'/nonexistent','ok'))?0:1);`,
  agy: `if (args[0]==='-p' && args[1]==='/usage') process.exit(fs.existsSync(require('path').join(process.env.HOME||'/nonexistent','ok'))?0:1);`,
});
const CLI = fileURLToPath(new URL('../bin/conductor-ai.js', import.meta.url));
const { setCooldown, getCooldowns } = await import('../src/cooldowns.js');
const { statusReport } = await import('../src/status.js');
const config = await import('../src/config.js');
const dir = (label) => path.join(home, 'accounts', 'codex-cli', label);
const cli = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env: process.env, input, encoding: 'utf8' });
const reset = () => { for (const f of ['config.json', 'state.json', 'accounts']) fs.rmSync(path.join(home, f), { recursive: true, force: true }); };

test('add, then list: the new account is not checked yet, and the first add shows the terms note once', () => {
  reset();
  const r = cli(['accounts', 'add', 'codex-cli', 'work2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/openai\.com\/policies\/terms-of-use\//);
  assert.match(r.stdout, /conductor-ai accounts login codex-cli work2/);
  const again = cli(['accounts', 'add', 'codex-cli', 'w3']);
  assert.doesNotMatch(again.stdout, /terms-of-use/);
  const list = cli(['accounts', 'codex-cli']);
  assert.match(list.stdout, /work2\s+not checked/);
  assert.match(list.stdout, /default\s+not checked/);
});

test('first Antigravity account add includes Google terms', () => {
  reset();
  const r = cli(['accounts', 'add', 'antigravity-cli', 'g2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/antigravity\.google\/terms/);
});

test('a bad label is refused with the allowed characters', () => {
  reset();
  const r = cli(['accounts', 'add', 'codex-cli', '../x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lowercase letters, digits, - and _/);
});

test('rm asks first: "n" keeps the folder, --yes deletes it', () => {
  reset();
  cli(['accounts', 'add', 'codex-cli', 'work2']);
  const no = cli(['accounts', 'rm', 'codex-cli', 'work2'], 'n\n');
  assert.equal(no.status, 0);
  assert.ok(fs.existsSync(dir('work2')));
  const yes = cli(['accounts', 'rm', 'codex-cli', 'work2', '--yes']);
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(fs.existsSync(dir('work2')), false);
});

test('order changes the listing', () => {
  reset();
  cli(['accounts', 'add', 'codex-cli', 'work2']);
  assert.equal(cli(['accounts', 'order', 'codex-cli', 'work2,default']).status, 0);
  const out = cli(['accounts', 'codex-cli']).stdout;
  assert.ok(out.indexOf('work2') < out.indexOf('default'), out);
});

test('check prints ready or needs sign-in from the status exit code', () => {
  reset();
  cli(['accounts', 'add', 'codex-cli', 'work2']);
  assert.match(cli(['accounts', 'check', 'codex-cli', 'work2']).stdout, /work2: needs sign-in/);
  fs.writeFileSync(path.join(dir('work2'), 'ok'), '');
  assert.match(cli(['accounts', 'check', 'codex-cli', 'work2']).stdout, /work2: ready/);
  assert.match(cli(['accounts', 'codex-cli']).stdout, /work2\s+ready/);
});

test('cooldown lists accounts and --clear <provider> clears its accounts too', () => {
  reset();
  cli(['accounts', 'add', 'codex-cli', 'work2']);
  setCooldown('codex-cli#work2', 60, 'rate limited');
  setCooldown('codex-cli', 60, 'rate limited');
  setCooldown('opencode', 60, 'rate limited');
  assert.match(cli(['cooldown']).stdout, /codex-cli \[work2\]/);
  assert.equal(cli(['cooldown', '--clear', 'codex-cli']).status, 0);
  const cd = getCooldowns();
  assert.equal(cd['codex-cli#work2'], undefined);
  assert.equal(cd['codex-cli'], undefined);
  assert.ok(cd.opencode);
});

test('status lists each account with its state', () => {
  reset();
  cli(['accounts', 'add', 'codex-cli', 'work2']);
  setCooldown('codex-cli#work2', 60, 'rate limited');
  assert.match(statusReport(config.loadConfig()), /codex-cli \[work2\] cooling down until/);
  assert.match(statusReport(config.loadConfig()), /codex-cli \[default\] not checked/);
});
