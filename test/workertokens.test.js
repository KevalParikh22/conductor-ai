// Worker token counts: Codex (--json events) and OpenCode (--format json + session export), in the shapes the real
// CLIs print (checked against codex-cli 0.166.0 and OpenCode 2.0.32).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { parseCodexJson, parseOpencodeJson, opencodeSessionTokens } = await import('../src/providers.js');
const { CLI_PRESETS } = await import('../src/presets.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const REPORT = '## RESULT: DONE\n## Files changed\n- none\n## Checks run\n- none\n## Notes\n- none\n';
const codexEvents = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: REPORT } },
  { type: 'turn.completed', usage: { input_tokens: 15772, cached_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 4 } },
];
const ocEvents = [
  { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
  { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: REPORT } },
];
const ocExport = { info: { id: 'ses_1', cost: 0, tokens: { input: 5857, output: 13, reasoning: 1, cache: { read: 100, write: 0 } } }, messages: [] };
const lines = (ev) => ev.map((e) => JSON.stringify(e)).join('\n');

test('parsers: Codex usage summed over turns, OpenCode text + session id + exported tokens; plain text is not JSON', () => {
  for (const m of ['write', 'read']) {
    assert.ok(CLI_PRESETS.codex[m].includes('--json'), `codex ${m} asks for JSON events`);
    assert.ok(CLI_PRESETS.opencode[m].join(' ').includes('--format json'), `opencode ${m} asks for JSON events`);
  }
  const two = lines([...codexEvents, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }]);
  assert.deepEqual(parseCodexJson(two), { text: REPORT, tokens: { input: 15782, output: 12 }, errors: [] });
  assert.equal(parseCodexJson('PONG\n'), null, 'an older Codex without --json: treated as text');
  assert.deepEqual(parseCodexJson(lines([{ type: 'error', message: 'rate limit reached' }])).errors, ['rate limit reached']);
  assert.deepEqual(parseOpencodeJson(lines(ocEvents)), { text: REPORT, sessionID: 'ses_1', errors: [] });
  assert.equal(parseOpencodeJson('PONG'), null);
  assert.deepEqual(opencodeSessionTokens('Exporting session: ses_1' + JSON.stringify(ocExport)), { input: 5957, output: 14 });
  assert.equal(opencodeSessionTokens('not json'), undefined);
});

test('dispatch records real token counts for Codex and OpenCode, and the answer is the report, not the JSON', async () => {
  fakeBins({
    'codex-tok': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{fs.writeFileSync(args[args.indexOf('-o')+1], ${JSON.stringify(REPORT)});console.log(${JSON.stringify(lines(codexEvents))});});`,
    'oc-tok': `if (args[0]==='session'&&args[1]==='export'&&args.includes('--standalone')&&args.includes('ses_1')) console.log(${JSON.stringify(JSON.stringify(ocExport))});
      else console.log(${JSON.stringify(lines(ocEvents))});`,
    'oc-noexport': `if (args[0]==='session') process.exit(1); console.log(${JSON.stringify(lines(ocEvents))});`,
  });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers = {
    cx: { type: 'cli', preset: 'codex', enabled: true, bin: 'codex-tok' },
    oc: { type: 'cli', preset: 'opencode', enabled: true, bin: 'oc-tok' },
    oc2: { type: 'cli', preset: 'opencode', enabled: true, bin: 'oc-noexport' },
  };
  for (const [name, tokens] of [['cx', { input: 15772, output: 10 }], ['oc', { input: 5957, output: 14 }], ['oc2', undefined]]) {
    const s = await dispatch(cfg, { role: 'ask', task: 'q', chain: [name] });
    assert.equal(s.winner, name);
    assert.match(fs.readFileSync(path.join(dir, s.report), 'utf8'), /RESULT: DONE/, `${name}: the answer, not the JSON events`);
    assert.deepEqual(s.attempts[0].tokens, tokens, `${name}: token counts`);
  }
});
