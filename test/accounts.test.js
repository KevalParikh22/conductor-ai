import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, fakeBins } from './helpers.js';
const home = isolateHome();
fakeBins({ codex: 'const path=require("path");process.exit(fs.existsSync(path.join(process.env.CODEX_HOME,"ok"))?0:1)', claude: 'const path=require("path");process.exit(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR,"ok"))?0:1)' });
const [{ validLabel, accountDir, addAccount, listAccounts, accountEnv, renameAccount, removeAccount, orderAccounts, checkAccount, accountStatus }, config, util] = await Promise.all([
  import('../src/accounts.js'), import('../src/config.js'), import('../src/util.js'),
]);
const putProvider = (name = 'codex-cli', preset = 'codex') => {
  const c = config.readScope('global', null); c.providers ||= {}; c.providers[name] = { type: 'cli', preset }; config.writeScope('global', null, c);
};

test('validates labels, derives directories and account environments', () => {
  assert.equal(validLabel('work-2'), true); assert.equal(validLabel('../x'), false); assert.equal(validLabel(''), false); assert.equal(validLabel('A'.repeat(40)), false);
  assert.equal(accountDir('codex-cli', 'work2'), path.join(util.GLOBAL_DIR, 'accounts', 'codex-cli', 'work2')); assert.equal(accountDir('codex-cli', 'default'), null);
  assert.deepEqual(accountEnv('codex', { label: 'work2', dir: '/x' }), { set: { CODEX_HOME: '/x' }, drop: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
  assert.deepEqual(accountEnv('codex', { label: 'default' }), { set: {}, drop: [] });
});
test('adds accounts and rejects invalid additions', () => {
  putProvider(); addAccount('codex-cli', 'work2');
  const dir = accountDir('codex-cli', 'work2');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.match(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), /cli_auth_credentials_store = "file"/);
  assert.equal(listAccounts(config.readScope('global', null), 'codex-cli')[0].key, 'codex-cli#work2');
  assert.throws(() => addAccount('codex-cli', 'work2')); assert.throws(() => addAccount('codex-cli', '../x')); assert.throws(() => addAccount('missing', 'x'));
  putProvider('oc', 'opencode'); assert.throws(() => addAccount('oc', 'x'));
  fs.writeFileSync(path.join(dir, 'config.toml'), 'keep'); assert.throws(() => addAccount('codex-cli', 'work2')); assert.equal(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), 'keep');
});
test('orders, checks, reports state, renames and removes accounts', async () => {
  putProvider(); addAccount('codex-cli', 'a'); addAccount('codex-cli', 'b');
  orderAccounts('codex-cli', ['b', 'a']); assert.deepEqual(listAccounts(config.readScope('global', null), 'codex-cli').map((x) => x.label), ['b', 'a']);
  assert.throws(() => orderAccounts('codex-cli', ['a']));
  fs.writeFileSync(path.join(accountDir('codex-cli', 'b'), 'ok'), '');
  assert.deepEqual(await checkAccount(config.loadConfig(), 'codex-cli', 'b'), { signedIn: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'))).accounts['codex-cli#b'].signedIn, true);
  assert.deepEqual(await checkAccount(config.loadConfig(), 'codex-cli', 'a'), { signedIn: false, reason: 'status command failed' });
  assert.equal(accountStatus(config.loadConfig(), 'codex-cli').find((x) => x.label === 'a').state, 'needs-sign-in');
  renameAccount('codex-cli', 'b', 'renamed'); assert.ok(fs.existsSync(accountDir('codex-cli', 'renamed')));
  assert.throws(() => renameAccount('codex-cli', 'default', 'x')); assert.throws(() => removeAccount('codex-cli', 'default'));
  removeAccount('codex-cli', 'renamed'); assert.equal(fs.existsSync(accountDir('codex-cli', 'renamed')), false);
});
test('account module never opens credential files', () => {
  const source = fs.readFileSync(new URL('../src/accounts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /auth\.json|\.credentials\.json/);
});
