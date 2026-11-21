// A catalog provider with via: 'codex' runs through the Codex CLI pointed at its own endpoint and key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { providerFromCatalog } = await import('../src/catalog.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

test('agentrouter becomes a Codex provider that sends its own base URL and key name, not the OpenAI login', async () => {
  const p = providerFromCatalog('agentrouter');
  assert.equal(p.type, 'cli');
  assert.equal(p.preset, 'codex');
  assert.equal(p.gateway, true);
  assert.deepEqual(p.passEnv, ['AGENTROUTER_API_KEY']);

  fakeBins({ codex: `const out=args[args.indexOf('-o')+1];fs.writeFileSync(out,'## RESULT: DONE\\nargs: '+args.join(' '));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));` });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.agentrouter = { ...p, enabled: true };
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['agentrouter'] });
  assert.equal(s.winner, 'agentrouter');
  const report = fs.readFileSync(`${dir}/${s.report}`, 'utf8');
  assert.match(report, /-c model_provider="agentrouter"/);
  assert.match(report, /model_providers\.agentrouter\.base_url="https:\/\/agentrouter\.org\/v1"/);
  assert.match(report, /model_providers\.agentrouter\.env_key="AGENTROUTER_API_KEY"/);
  assert.match(report, /-m gpt-6\.1-sol/);
});

test('a plain Codex provider gets no gateway arguments', async () => {
  fakeBins({ codex: `const out=args[args.indexOf('-o')+1];fs.writeFileSync(out,'## RESULT: DONE\\nargs: '+args.join(' '));` });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers['codex-cli'].enabled = true;
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['codex-cli'] });
  assert.doesNotMatch(fs.readFileSync(`${dir}/${s.report}`, 'utf8'), /model_provider/);
});
