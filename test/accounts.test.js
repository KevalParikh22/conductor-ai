// Account pool: the accounts module (folders, config, sign-in checks). Fake `codex`/`claude` CLIs stand in for the
// real ones: their status command exits 0 only when a file named `ok` is in the account's folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, fakeBins } from './helpers.js';

const home = isolateHome();
fakeBins({
  codex: `if (args[0]==='login' && args[1]==='status') { if (process.env.SLOW) setTimeout(()=>{}, 60000); else process.exit(fs.existsSync(require('path').join(process.env.CODEX_HOME||'/nonexistent','ok'))?0:1); }
else if (args[0]==='login') { fs.writeFileSync(require('path').join(process.env.CODEX_HOME,'ok'), ''); }`,
  claude: `process.exit(fs.existsSync(require('path').join(process.env.CLAUDE_CONFIG_DIR||'/nonexistent','ok'))?0:1)`,
  agy: `if (args[0]==='-p' && args[1]==='/usage') process.exit(fs.existsSync(require('path').join(process.env.HOME||'/nonexistent','ok'))?0:1);`,
});
const acc = await import('../src/accounts.js');
const { validLabel, accountDir, addAccount, listAccounts, accountEnv, envFor, renameAccount, removeAccount, orderAccounts, setAccountEnabled, checkAccount, loginAccount, accountStatus } = acc;
const config = await import('../src/config.js');
const { GLOBAL_DIR } = await import('../src/util.js');
const { UsageError } = await import('../src/core.js');
const { setCooldown, getCooldowns } = await import('../src/cooldowns.js');

const state = () => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
const labels = (p = 'codex-cli') => listAccounts(config.loadConfig(), p).map((a) => a.label);
const reset = () => { fs.rmSync(path.join(home, 'config.json'), { force: true }); fs.rmSync(path.join(home, 'state.json'), { force: true }); fs.rmSync(path.join(home, 'accounts'), { recursive: true, force: true }); };

test('labels, folders and the environment of an account', () => {
  assert.equal(validLabel('work-2'), true);
  for (const bad of ['../x', '', 'A'.repeat(40), 'Work', 'a/b', '-x']) assert.equal(validLabel(bad), false, bad);
  assert.equal(accountDir('codex-cli', 'work2'), path.join(GLOBAL_DIR, 'accounts', 'codex-cli', 'work2'));
  assert.equal(accountDir('codex-cli', 'default'), null);
  assert.deepEqual(accountEnv('codex', { label: 'work2', dir: '/x' }), { set: { CODEX_HOME: '/x' }, drop: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
  assert.deepEqual(accountEnv('claude', { label: 'b', dir: '/y' }), { set: { CLAUDE_CONFIG_DIR: '/y' }, drop: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] });
  assert.deepEqual(accountEnv('antigravity', { label: 'g2', dir: '/x' }), { set: { HOME: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' }, drop: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_ADC_AUTH'] });
  assert.deepEqual(accountEnv('codex', { label: 'default' }), { set: {}, drop: [] });
  // a removed key is deleted, not emptied: an empty OPENAI_API_KEY could still be picked over the login
  const env = envFor('codex', { label: 'w', dir: '/x' }, { OPENAI_API_KEY: 'k', PATH: '/bin' });
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal(env.CODEX_HOME, '/x');
  assert.equal(env.PATH, '/bin');
});

test('adding works for a built-in provider that is not in the global config, and keeps the normal login first', () => {
  reset();
  addAccount('codex-cli', 'work2');
  const dir = accountDir('codex-cli', 'work2');
  if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), /cli_auth_credentials_store = "file"/);
  assert.deepEqual(labels(), ['default', 'work2']);
  assert.equal(listAccounts(config.loadConfig(), 'codex-cli')[1].key, 'codex-cli#work2');
  // the rest of the provider's config (enabled, preset) still comes from the defaults
  assert.equal(config.loadConfig().providers['codex-cli'].preset, 'codex');
});

test('bad additions are refused with a plain message', () => {
  reset();
  addAccount('codex-cli', 'work2');
  assert.throws(() => addAccount('codex-cli', 'work2'), (e) => e instanceof UsageError && /already has/.test(e.message));
  assert.throws(() => addAccount('codex-cli', '../x'), (e) => e instanceof UsageError && /lowercase letters, digits/.test(e.message));
  assert.throws(() => addAccount('nope', 'x'), (e) => e instanceof UsageError && /unknown provider/.test(e.message));
  assert.throws(() => addAccount('opencode', 'x'), (e) => e instanceof UsageError && /cannot have accounts/.test(e.message));
  assert.throws(() => addAccount('antigravity-cli', '../x'), /invalid account label/);
});

test('Antigravity accounts are isolated under HOME and checked through agy usage status', async () => {
  reset();
  if (process.platform !== 'linux') return;
  addAccount('antigravity-cli', 'g2');
  assert.deepEqual(labels('antigravity-cli'), ['default', 'g2']);
  assert.ok(fs.existsSync(accountDir('antigravity-cli', 'g2')));
  assert.deepEqual(await checkAccount(config.loadConfig(), 'antigravity-cli', 'g2'), { signedIn: false, reason: 'not signed in' });
  fs.writeFileSync(path.join(accountDir('antigravity-cli', 'g2'), 'ok'), '');
  assert.deepEqual(await checkAccount(config.loadConfig(), 'antigravity-cli', 'g2'), { signedIn: true });
});

test('Antigravity account add is Linux only', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    assert.throws(() => addAccount('antigravity-cli', 'g3'), (e) => e instanceof UsageError && /Linux only/.test(e.message));
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('an existing config.toml in an account folder is left alone', () => {
  reset();
  const dir = accountDir('codex-cli', 'kept');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "x"\n');
  addAccount('codex-cli', 'kept');
  assert.equal(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), 'model = "x"\n');
});

test('order, on/off, and the errors for a wrong order', () => {
  reset();
  addAccount('codex-cli', 'a'); addAccount('codex-cli', 'b');
  orderAccounts('codex-cli', ['b', 'default', 'a']);
  assert.deepEqual(labels(), ['b', 'default', 'a']);
  assert.throws(() => orderAccounts('codex-cli', ['a', 'b']), UsageError); // one missing
  assert.throws(() => orderAccounts('codex-cli', ['a', 'b', 'default', 'c']), UsageError); // one extra
  assert.throws(() => orderAccounts('codex-cli', ['a', 'a', 'b']), UsageError); // twice
  setAccountEnabled('codex-cli', 'a', false);
  assert.equal(accountStatus(config.loadConfig(), 'codex-cli').find((x) => x.label === 'a').state, 'disabled');
  setAccountEnabled('codex-cli', 'a', true);
  assert.equal(accountStatus(config.loadConfig(), 'codex-cli').find((x) => x.label === 'a').state, 'unchecked');
});

test('checks read only the exit code, save a yes/no, and time out', async () => {
  reset();
  addAccount('codex-cli', 'a'); addAccount('codex-cli', 'b');
  fs.writeFileSync(path.join(accountDir('codex-cli', 'b'), 'ok'), '');
  assert.deepEqual(await checkAccount(config.loadConfig(), 'codex-cli', 'b'), { signedIn: true });
  assert.equal(state().accounts['codex-cli#b'].signedIn, true);
  assert.deepEqual(await checkAccount(config.loadConfig(), 'codex-cli', 'a'), { signedIn: false, reason: 'not signed in' });
  assert.equal(state().accounts['codex-cli#a'].signedIn, false);
  process.env.SLOW = '1';
  try {
    const kind = acc.ACCOUNT_KINDS.codex, before = kind.statusTimeoutMs;
    kind.statusTimeoutMs = 300;
    try { assert.deepEqual(await checkAccount(config.loadConfig(), 'codex-cli', 'b'), { signedIn: false, reason: 'the status check timed out' }); } finally { kind.statusTimeoutMs = before; }
  } finally { delete process.env.SLOW; }
  // the default account checks the normal login (no CODEX_HOME from conductor-ai): the fake says not signed in
  assert.equal((await checkAccount(config.loadConfig(), 'codex-cli', 'default')).signedIn, false);
});

test('sign-in runs the CLI with the account folder, then checks it', async () => {
  reset();
  addAccount('codex-cli', 'w');
  assert.deepEqual(await loginAccount(config.loadConfig(), 'codex-cli', 'w'), { signedIn: true });
  assert.equal(accountStatus(config.loadConfig(), 'codex-cli').find((x) => x.label === 'w').state, 'ready');
  // the user's normal login is never signed in or out by conductor-ai
  await assert.rejects(loginAccount(config.loadConfig(), 'codex-cli', 'default'), /leaves it alone/);
});

test('status shows cooling with its end, needs sign-in and disabled', async () => {
  reset();
  addAccount('codex-cli', 'a'); addAccount('codex-cli', 'b'); addAccount('codex-cli', 'c');
  setCooldown('codex-cli#a', 60, 'rate limited');
  await checkAccount(config.loadConfig(), 'codex-cli', 'b');
  setAccountEnabled('codex-cli', 'c', false);
  const s = Object.fromEntries(accountStatus(config.loadConfig(), 'codex-cli').map((x) => [x.label, x]));
  assert.equal(s.a.state, 'cooling');
  assert.ok(s.a.until > Date.now());
  assert.equal(s.b.state, 'needs-sign-in');
  assert.match(s.b.reason, /conductor-ai accounts login codex-cli b/);
  assert.equal(s.c.state, 'disabled');
});

test('rename moves the folder, its cooldowns and its saved state; remove deletes them', async () => {
  reset();
  addAccount('codex-cli', 'a');
  await checkAccount(config.loadConfig(), 'codex-cli', 'a');
  setCooldown('codex-cli#a', 60, 'rate limited');
  setCooldown('codex-cli#a@gpt-x', 60, 'rate limited');
  renameAccount('codex-cli', 'a', 'z');
  assert.ok(fs.existsSync(accountDir('codex-cli', 'z')));
  assert.equal(fs.existsSync(accountDir('codex-cli', 'a')), false);
  assert.deepEqual(labels(), ['default', 'z']);
  const cd = getCooldowns();
  assert.ok(cd['codex-cli#z'] && cd['codex-cli#z@gpt-x']);
  assert.equal(cd['codex-cli#a'], undefined);
  assert.equal(state().accounts['codex-cli#z'].signedIn, false);
  assert.throws(() => renameAccount('codex-cli', 'default', 'x'), UsageError);
  assert.throws(() => renameAccount('codex-cli', 'z', 'default'), UsageError);
  assert.throws(() => removeAccount('codex-cli', 'default'), UsageError);
  removeAccount('codex-cli', 'z');
  assert.equal(fs.existsSync(accountDir('codex-cli', 'z')), false);
  assert.deepEqual(labels(), ['default']);
  assert.equal(getCooldowns()['codex-cli#z'], undefined);
  assert.equal(getCooldowns()['codex-cli#z@gpt-x'], undefined);
  assert.equal(state().accounts['codex-cli#z'], undefined);
});

test('the module never names a credential file', () => {
  const source = fs.readFileSync(new URL('../src/accounts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /auth\.json|\.credentials\.json|readFileSync/);
});
