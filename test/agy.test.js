// V8: Antigravity (agy) under pressure: quota reset times, other model families, one task at a time, permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { resetSeconds, testPermissions } = await import('../src/providers.js');
const { dispatch, clearCooldowns, getCooldowns, withSlot } = await import('../src/core.js');
const { cliFallbacks, modelFamily } = await import('../src/models.js');
const { spreadChains } = await import('../src/batch.js');
const { loadConfig } = await import('../src/config.js');
const { untilText } = await import('../src/util.js');

// the message agy really prints (agy 1.5.x, exit 3, stderr)
const QUOTA = (h) => `error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${h}h3m13s.`;
const MODELS = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)';
const REPORT = '## RESULT: DONE\\n## Files changed\\n- none\\n## Checks run\\n- none\\n## Notes\\n- none\\n';
// a fake agy: `models` lists models; a model in OUT_OF_QUOTA (or the default) answers with the quota error
const fakeAgy = (outOfQuota, hours = 5) => `
  if (args[0] === 'models') { console.log('Fetching available models...'); console.log(${JSON.stringify(MODELS)}); process.exit(0); }
  const m = args.includes('--model') ? args[args.indexOf('--model') + 1] : '(default)';
  const fam = m === '(default)' ? 'gemini' : m.match(/^[a-z]+/)[0];
  const out = ${JSON.stringify(outOfQuota)};
  if (out.includes(fam) || out.includes('*')) { console.error(${JSON.stringify(QUOTA(hours))}.replace('${hours}h', (out.includes('*') ? ${hours} : ${hours} + out.indexOf(fam)) + 'h')); process.exit(3); }
  console.log(JSON.stringify({ status: 'SUCCESS', response: '${REPORT}', usage: { input_tokens: 10, output_tokens: 2 } }));`;

const cfgWith = (dir, providers) => { const cfg = loadConfig(dir); cfg.providers = providers; return cfg; };
const agy = (bin) => ({ type: 'cli', preset: 'antigravity', enabled: true, bin });

test('reset time is read from the provider\'s own words, including agy\'s compact form', () => {
  assert.equal(resetSeconds(QUOTA(118)), 118 * 3600 + 3 * 60 + 13);
  assert.equal(resetSeconds('Rate limited. Try again in 30s'), 30);
  assert.equal(resetSeconds('please retry after 120 seconds'), 120);
  assert.equal(resetSeconds('quota resets in 5 minutes'), 300);
  assert.equal(resetSeconds('no hint here'), 0);
  assert.equal(resetSeconds('Resets in 9999h'), 7 * 86_400, 'capped at a week');
  assert.match(untilText(Date.now() + 5 * 86_400_000), /\d/, 'a later day shows its date');
  assert.equal(untilText(Date.now() + 60_000).includes(':'), true);
});

test('quota on agy\'s default model: it tries another model family, and the cooldown lasts until the real reset', async () => {
  fakeBins({ 'agy-gem-out': fakeAgy(['gemini']) });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = cfgWith(dir, { agy: agy('agy-gem-out') });
  const s = await dispatch(cfg, { role: 'ask', task: 'q', chain: ['agy'] });
  assert.equal(s.winner, 'agy');
  assert.equal(s.model, 'claude-sonnet-4-6', 'the next family, not another Gemini model');
  assert.equal(s.attempts[0].reason, 'quota (cooldown 304m)', '5h3m13s → 304 minutes, rounded up, not the default 30');
  const cd = getCooldowns();
  assert.ok(cd['agy@(default)'], 'the default model cools down');
  assert.ok(!cd.agy, 'agy itself does not: another model worked');
  assert.ok(Math.abs(cd['agy@(default)'].until - (Date.now() + 304 * 60_000)) < 120_000, 'until the reset agy reported');

  // next run: the default model is cooling, so agy starts on another family straight away
  const s2 = await dispatch(cfg, { role: 'ask', task: 'q', chain: ['agy'] });
  assert.equal(s2.winner, 'agy');
  assert.equal(s2.attempts.length, 1);
});

test('two models with the same reset time share the account\'s quota: stop after two, cool agy down until the reset', async () => {
  fakeBins({ 'agy-all-out': fakeAgy(['*'], 118) });
  clearCooldowns();
  const { dir } = makeRepo();
  const s = await dispatch(cfgWith(dir, { agy: agy('agy-all-out') }), { role: 'ask', task: 'q', chain: ['agy'] });
  assert.equal(s.winner, null);
  assert.equal(s.attempts.filter((a) => !a.skipped).length, 2, 'not every model: the second identical reset proves it is the account');
  const cd = getCooldowns().agy;
  assert.equal(cd.reason, 'quota used up for the whole account');
  assert.ok(cd.until > Date.now() + 117 * 3600_000, 'days, not the default 30 minutes');
  assert.match(s.attempts[1].next, /cools down/);
});

test('model families: other families first, one each, then the rest; the list is cached', async () => {
  assert.equal(modelFamily('claude-sonnet-4-6'), 'claude');
  let calls = 0;
  const run = async () => { calls++; return { code: 0, stdout: `Fetching...\n${MODELS.replace(/\\t/g, '\t').replace(/\\n/g, '\n')}\n` }; };
  const preset = { bin: 'agy', listModels: ['models'] };
  assert.deepEqual(await cliFallbacks('agy-x', preset, { except: '', defaultFamily: 'gemini', run }), ['claude-sonnet-4-6', 'gpt-oss-120b-medium', 'gemini-3.8-flash-high']);
  assert.deepEqual(await cliFallbacks('agy-x', preset, { except: 'claude-sonnet-4-6', run }), ['gemini-3.8-flash-high', 'gpt-oss-120b-medium', 'gemini-3.8-flash-low']);
  assert.equal(calls, 1, 'agy models runs once a day, not per task');
});

test('one agy task at a time: batch spreads past it, and concurrent calls wait their turn', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = cfgWith(dir, { agy: agy('node'), oc: { type: 'cli', preset: 'opencode', enabled: true, bin: 'node' } });
  cfg.roles = { ...cfg.roles, build: ['agy', 'oc'] };
  const items = ['T1', 'T2', 'T3'].map((id) => ({ id, role: 'build', files: ['a.js', 'b.js', 'c.js'], section: `### ${id}: x\n- **files:** \`a.js\`, \`b.js\`, \`c.js\`` }));
  assert.deepEqual(spreadChains(cfg, items).map((t) => t.chain[0]), ['agy', 'oc', 'oc'], 'agy takes one, the rest go on');
  cfg.providers.agy.maxParallel = 2;
  assert.equal(spreadChains(cfg, items).filter((t) => t.chain[0] === 'agy').length, 2, 'your own limit wins');

  const order = [];
  const job = (id, ms) => withSlot('agy-slot', 1, async () => { order.push(`${id}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${id}-`); }, () => order.push(`${id} waits`));
  await Promise.all([job('a', 40), job('b', 5), job('c', 5)]);
  assert.deepEqual(order, ['a+', 'b waits', 'c waits', 'a-', 'b+', 'b-', 'c+', 'c-']);
  const free = [];
  await Promise.all([withSlot('x', undefined, async () => free.push(1)), withSlot('x', undefined, async () => free.push(2))]);
  assert.equal(free.length, 2, 'no limit: no waiting');
});

test('permission preflight: an agent that can run npm test passes; one that is refused names what to allow', async () => {
  fakeBins({
    'agy-can': `const out = require('child_process').execSync('npm test', { encoding: 'utf8' });
      console.log(JSON.stringify({ status: 'SUCCESS', response: 'It printed: ' + out.trim().split('\\n').pop() }));`,
    'agy-cannot': `console.log(JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] }));`,
  });
  const dir = makeRepo().dir;
  const ok = await testPermissions('agy', agy('agy-can'), dir);
  assert.deepEqual([ok.ok, ok.reason], [true, 'can run build commands']);
  const no = await testPermissions('agy', agy('agy-cannot'), dir);
  assert.equal(no.ok, false);
  assert.deepEqual(no.denied, ['command']);
  assert.match(no.reason, /^refused: command/);
});
