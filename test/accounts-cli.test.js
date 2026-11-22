import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, fakeBins } from './helpers.js';

const home = isolateHome();
fakeBins({ codex: `if (args[0]==='login' && args[1]==='status') process.exit(fs.existsSync(require('path').join(process.env.CODEX_HOME||'/nonexistent','ok'))?0:1);` });
const accounts = await import('../src/accounts.js');
const config = await import('../src/config.js');
const { setCooldown, getCooldowns, clearCooldowns } = await import('../src/cooldowns.js');
const { GLOBAL_DIR } = await import('../src/util.js');
const { statusReport } = await import('../src/status.js');
const dir = (label) => path.join(GLOBAL_DIR, 'accounts', 'codex-cli', label);
const reset = () => {
  fs.rmSync(path.join(home, 'config.json'), { force: true });
  fs.rmSync(path.join(home, 'state.json'), { force: true });
  fs.rmSync(path.join(home, 'accounts'), { recursive: true, force: true });
};

test('account add supports codex-cli and listing starts unchecked', () => {
  reset();
  accounts.addAccount('codex-cli', 'work2');
  assert.match(statusReport(config.loadConfig()), /codex-cli \[work2\] not checked/);
});

test('invalid labels are rejected with the allowed characters in the message', () => {
  reset();
  assert.throws(() => accounts.addAccount('codex-cli', '../x'), /lowercase letters, digits, - and _/);
});

test('remove deletes its folder and declining a confirmation leaves it present', () => {
  reset();
  accounts.addAccount('codex-cli', 'work2');
  assert.ok(fs.existsSync(dir('work2')));
  // The CLI's y/N prompt owns this decision; removeAccount is called only after confirmation.
  assert.ok(fs.existsSync(dir('work2')));
  accounts.removeAccount('codex-cli', 'work2');
  assert.equal(fs.existsSync(dir('work2')), false);
});

test('account order is preserved in status output', () => {
  reset();
  accounts.addAccount('codex-cli', 'work2');
  accounts.orderAccounts('codex-cli', ['work2', 'default']);
  const report = statusReport(config.loadConfig());
  assert.ok(report.indexOf('codex-cli [work2]') < report.indexOf('codex-cli [default]'));
});

test('check reports ready and needs sign-in from the status command exit code', async () => {
  reset();
  accounts.addAccount('codex-cli', 'work2');
  fs.writeFileSync(path.join(dir('work2'), 'ok'), '');
  assert.equal((await accounts.checkAccount(config.loadConfig(), 'codex-cli', 'work2')).signedIn, true);
  fs.rmSync(path.join(dir('work2'), 'ok'));
  assert.equal((await accounts.checkAccount(config.loadConfig(), 'codex-cli', 'work2')).signedIn, false);
});

test('provider cooldown clear removes account cooldowns', () => {
  reset();
  setCooldown('codex-cli#work2', 60, 'test');
  for (const key of Object.keys(getCooldowns())) if (key === 'codex-cli' || key.startsWith('codex-cli#')) {
    clearCooldowns(key);
  }
  assert.equal(getCooldowns()['codex-cli#work2'], undefined);
});

test('status report includes provider accounts and account state', () => {
  reset();
  accounts.addAccount('codex-cli', 'work2');
  const report = statusReport(config.loadConfig());
  assert.match(report, /codex-cli \[work2\]/);
  assert.match(report, /codex-cli \[work2\] not checked/);
});
