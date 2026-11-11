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
const argLog = (name) => path.join(fs.realpathSync(home), `${name}.args.json`);
fakeBins({
  copilot: `fs.writeFileSync(${JSON.stringify(path.join(fs.realpathSync(home), 'copilot.args.json'))}, JSON.stringify(args)); console.log('## RESULT: DONE padding padding padding');`,
  grok: `fs.writeFileSync(${JSON.stringify(path.join(fs.realpathSync(home), 'grok.args.json'))}, JSON.stringify(args)); console.log('## RESULT: DONE padding padding padding');`,
  'kiro-cli': `fs.writeFileSync(${JSON.stringify(path.join(fs.realpathSync(home), 'kiro-cli.args.json'))}, JSON.stringify(args)); console.log('## RESULT: DONE padding padding padding');`,
  goose: `fs.writeFileSync(${JSON.stringify(path.join(fs.realpathSync(home), 'goose.args.json'))}, JSON.stringify({ args, mode: process.env.GOOSE_MODE })); console.log('## RESULT: DONE padding padding padding');`,
  committer: `require('child_process').execSync('git commit -q --allow-empty -m sneaky'); console.log('## RESULT: DONE\\n## Files changed\\n- (none)');`,
  aider: `fs.writeFileSync(${JSON.stringify(path.join(fs.realpathSync(home), 'aider.args.json'))}, JSON.stringify(args)); console.log('## RESULT: DONE padding padding padding');`,
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

test('copilot: write denies git push and sudo; read denies every write tool and the shell', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers['copilot-cli'].enabled = true;
  await dispatch(cfg, { role: 'fix', task: 'fix it', chain: ['copilot-cli'], noVerify: true });
  let args = JSON.parse(fs.readFileSync(argLog('copilot'), 'utf8'));
  const denied = args.flatMap((a, i) => (a === '--deny-tool' ? [args[i + 1]] : []));
  for (const c of ['shell(git push)', 'shell(git commit)', 'shell(sudo)']) assert.ok(denied.includes(c), c);
  assert.ok(args.includes('--no-ask-user') && args.includes('-p'));
  assert.ok(!args.includes('--allow-all-paths') && !args.includes('--yolo') && !args.includes('--trust-folder'));
  await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['copilot-cli'] });
  args = JSON.parse(fs.readFileSync(argLog('copilot'), 'utf8'));
  const deniedRead = args.flatMap((a, i) => (a === '--deny-tool' ? [args[i + 1]] : []));
  assert.deepEqual(deniedRead, ['write', 'shell', 'memory', 'url']);
  assert.ok(args.includes('--disable-builtin-mcps'), 'its GitHub MCP server could push through the API');
  assert.equal(readOnlyEnforced(cfg.providers['copilot-cli']), true);
});

test('aider: never commits, never runs shell commands, never loads the project .env; read is a dry run', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.aider.enabled = true;
  const s = await dispatch(cfg, { role: 'fix', task: 'fix it', chain: ['aider'], noVerify: true });
  assert.equal(s.winner, 'aider', JSON.stringify(s.attempts));
  let args = JSON.parse(fs.readFileSync(argLog('aider'), 'utf8'));
  for (const f of ['--no-auto-commits', '--no-dirty-commits', '--no-suggest-shell-commands', '--message-file']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--env-file') + 1], (await import('node:os')).devNull);
  assert.ok(!args.includes('--dry-run'));
  await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['aider'] });
  args = JSON.parse(fs.readFileSync(argLog('aider'), 'utf8'));
  assert.ok(args.includes('--dry-run'));
});

const run = async (name, role, task) => {
  clearCooldowns();
  const { dir } = makeRepo({ files: { 'AGENTS.md': '# Rules\nproject context marker\n' } });
  const cfg = loadConfig(dir);
  cfg.providers[name].enabled = true;
  const s = await dispatch(cfg, { role, task, chain: [name], noVerify: true });
  assert.equal(s.winner, name, JSON.stringify(s.attempts));
  return s;
};
const argsOf = (bin) => JSON.parse(fs.readFileSync(argLog(bin), 'utf8'));
const denies = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test('grok: strict OS sandbox and git/sudo denied for writes; read-only sandbox and read tools for reads', async () => {
  await run('grok-cli', 'fix', 'fix it');
  let a = argsOf('grok');
  assert.equal(a[a.indexOf('--sandbox') + 1], 'strict');
  assert.ok(denies(a, '--deny').includes('Bash(git push*)') && denies(a, '--deny').includes('Bash(sudo*)'));
  assert.ok(!a.includes('--yolo'));
  await run('grok-cli', 'ask', 'what?');
  a = argsOf('grok');
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(a[a.indexOf('--tools') + 1], 'read_file,grep,list_dir');
  assert.ok(!a.includes('--always-approve'));
});

test('kiro: writes require its command sandbox; reads trust only read and search tools', async () => {
  await run('kiro-cli', 'fix', 'fix it');
  let a = argsOf('kiro-cli');
  assert.ok(a.includes('--sandbox') && a.includes('--no-interactive'));
  await run('kiro-cli', 'ask', 'what?');
  a = argsOf('kiro-cli');
  assert.ok(!a.includes('--trust-all-tools') && !a.includes('--sandbox'));
  assert.ok(a.includes('--trust-tools=read_file,grep_search'));
});

test('goose: read mode is tool-less chat with the project context inlined; write mode is flagged as not contained', async () => {
  await run('goose', 'ask', 'what?');
  const g = argsOf('goose');
  assert.equal(g.mode, 'chat');
  assert.match(g.args[g.args.indexOf('-t') + 1], /project context marker/);
  await run('goose', 'fix', 'fix it');
  assert.equal(argsOf('goose').mode, 'auto');
  assert.match(providerPermissions({ type: 'cli', preset: 'goose' }).write, /no permission control/);
});

test('a worker that commits on its own is reported', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.committer = { type: 'cli', enabled: true, bin: 'committer', write: ['x'], read: ['x'] };
  const s = await dispatch(cfg, { role: 'fix', task: 'x', chain: ['committer'], noVerify: true });
  assert.ok(s.warnings.some((w) => /made git commits itself/.test(w)), JSON.stringify(s.warnings));
});

test('worker flags stay on supported, contained settings (Codex, OpenCode v2)', async () => {
  const { CLI_PRESETS } = await import('../src/presets.js');
  const codex = [...CLI_PRESETS.codex.write, ...CLI_PRESETS.codex.read].join(' ');
  assert.ok(!codex.includes('--full-auto'), '--full-auto was removed from Codex');
  assert.ok(!/approval_policy="?untrusted/.test(codex), 'untrusted is retired and can stop Codex from starting');
  assert.match(codex, /approval_policy="never"/);
  // OpenCode 2 turns these rules into an ordered list where the LAST match wins: the catch-all must come first
  const { read, write } = CLI_PRESETS.opencode.modeEnv;
  const rb = Object.entries(read.OPENCODE_CONFIG_CONTENT.permission.bash), wb = Object.entries(write.OPENCODE_CONFIG_CONTENT.permission.bash);
  assert.deepEqual(rb[0], ['*', 'deny']); assert.ok(rb.slice(1).every(([, v]) => v === 'allow'));
  assert.deepEqual(wb[0], ['*', 'allow']); assert.ok(wb.slice(1).every(([, v]) => v === 'deny'));
  assert.equal(read.OPENCODE_CONFIG_CONTENT.permission.edit, 'deny');
});
