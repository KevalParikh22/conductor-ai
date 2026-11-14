// Idle limit per agent: on for Codex (its --json mode prints an event per step), off for agents that print only at
// the end; a provider's own idleTimeoutMin (0 = never) and the global idleTimeoutSec win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { workerTimeout, dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig, validateConfig } = await import('../src/config.js');

test('defaults: Codex 10 minutes, the others none; the provider and the global setting win', () => {
  const idle = (p, settings = {}) => workerTimeout({ type: 'cli', ...p }, 'agent', settings).idleTimeoutMs;
  assert.equal(idle({ preset: 'codex' }), 600_000);
  assert.equal(idle({ preset: 'antigravity' }), 0);
  assert.equal(idle({ preset: 'opencode' }), 0);
  assert.equal(idle({ preset: 'codex', idleTimeoutMin: 0 }), 0, '0 turns it off');
  assert.equal(idle({ preset: 'codex', idleTimeoutMin: 2 }), 120_000);
  assert.equal(idle({ preset: 'antigravity' }, { idleTimeoutSec: 300 }), 300_000, 'the global setting applies to every agent');
  const cfg = loadConfig(makeRepo().dir);
  cfg.providers.x = { type: 'cli', enabled: true, bin: 'x', idleTimeoutMin: 0 };
  assert.deepEqual(validateConfig(cfg).filter((e) => /idleTimeoutMin/.test(e)), [], '0 is a valid idle limit');
});

test('a Codex that prints and then goes silent is stopped by the idle limit, and the next provider runs', async () => {
  fakeBins({
    'codex-hangs': "process.stdin.resume(); console.log(JSON.stringify({ type: 'turn.started' })); setTimeout(() => {}, 60000);",
    'codex-ok': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{fs.writeFileSync(args[args.indexOf('-o')+1],'## VERDICT: APPROVE\\nall good here, nothing to add');});`,
  });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers = { hang: { type: 'cli', preset: 'codex', enabled: true, bin: 'codex-hangs', idleTimeoutMin: 0.02 }, ok: { type: 'cli', preset: 'codex', enabled: true, bin: 'codex-ok' } };
  const t0 = Date.now();
  const s = await dispatch(cfg, { role: 'ask', task: 'q', chain: ['hang', 'ok'] });
  assert.match(s.attempts[0].reason, /^idle \(no output for/);
  assert.equal(s.winner, 'ok');
  assert.ok(Date.now() - t0 < 30_000);
});
