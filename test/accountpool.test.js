import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome } from './helpers.js';

const home = isolateHome();
const { resolveChain } = await import('../src/core.js');
const { workerEnv } = await import('../src/providers.js');
const { loadConfig } = await import('../src/config.js');
const { addAccount, accountDir, markSignedIn } = await import('../src/accounts.js');
const { setCooldown, clearCooldowns } = await import('../src/cooldowns.js');

test('resolveChain expands accounts in order and skips account cooldowns and saved sign-in failures', () => {
  addAccount('codex-cli', 'a');
  addAccount('codex-cli', 'b');
  markSignedIn('codex-cli#a', false);
  setCooldown('codex-cli#b', 10, 'rate limited');
  const cfg = loadConfig();
  const chain = resolveChain(cfg, 'build', { chain: ['codex-cli'] });
  assert.deepEqual(chain.map((c) => [c.name, c.account?.label, c.key]), [
    ['codex-cli', 'default', 'codex-cli#default'],
    ['codex-cli', 'a', 'codex-cli#a'],
    ['codex-cli', 'b', 'codex-cli#b'],
  ]);
  assert.match(chain[1].skip, /^needs sign-in:/);
  assert.match(chain[2].skip, /^account cooling down until/);
  clearCooldowns();
  assert.equal(resolveChain({ ...cfg, providers: { ...cfg.providers, 'codex-cli': { ...cfg.providers['codex-cli'], accounts: undefined } } }, 'build', { chain: ['codex-cli'] })[0].key, 'codex-cli');
});

test('workerEnv applies account overrides after passEnv and leaves default login home alone', () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'secret';
  try {
    const preset = { passEnv: ['OPENAI_API_KEY'] };
    const homeEnv = workerEnv(preset, 'read', process.cwd(), { set: { CODEX_HOME: accountDir('codex-cli', 'work') }, drop: ['OPENAI_API_KEY'] });
    assert.equal(homeEnv.CODEX_HOME, accountDir('codex-cli', 'work'));
    assert.equal('OPENAI_API_KEY' in homeEnv, false);
    const defaultEnv = workerEnv(preset, 'read', process.cwd(), { set: {}, drop: [] });
    assert.equal(defaultEnv.CODEX_HOME, undefined);
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before;
  }
});

