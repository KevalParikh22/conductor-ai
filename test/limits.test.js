// Time limits (whole process tree stopped, task eta, idle) and fallback models on one provider.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
// "hangs": starts a grandchild that keeps stdout open, then waits for it, the way agents with helper processes hang
fakeBins({
  'agent-hang': `const { spawn } = require('child_process'); spawn('sleep', ['60'], { stdio: 'inherit' }); console.log('working…');`,
  'agent-ok': `console.log('## RESULT: DONE\\n## Files changed\\n- (none)\\n## Notes\\n- ok');`,
  'agent-quiet': `setTimeout(() => console.log('late'), 60000);`,
});

const { run } = await import('../src/util.js');
const { dispatch, clearCooldowns, getCooldowns, parseDuration, workerTimeout } = await import('../src/core.js');
const { loadConfig, validateConfig } = await import('../src/config.js');

test('a timeout stops the whole process tree, even when a grandchild holds the output open', async () => {
  const t0 = Date.now();
  // 2s gives a slow CI runner time to start the script and print; the grandchild sleeps 60s, so finishing well
  // before that proves the whole group was stopped
  const r = await run('agent-hang', [], { timeoutMs: 2000 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 30_000, `stopped in ${Date.now() - t0}ms`);
  assert.match(r.stdout, /working/);
});

test('an idle limit stops a worker that prints nothing', async () => {
  const r = await run('agent-quiet', [], { idleTimeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.equal(r.idle, true);
});

test('durations and limits: eta raises the limit, --timeout wins, APIs stay capped', () => {
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('45 min'), 2_700_000);
  assert.equal(parseDuration('2 hours'), 7_200_000);
  assert.equal(parseDuration('90'), 5_400_000);
  assert.equal(parseDuration('soon'), 0);
  const settings = { timeoutSec: 1200, timeoutFactor: 2, apiTimeoutSec: 300 };
  assert.equal(workerTimeout({}, 'agent', settings).timeoutMs, 1_200_000);
  assert.equal(workerTimeout({}, 'agent', settings, { etaMs: 3_600_000 }).timeoutMs, 7_200_000, 'eta 1h → 2h');
  assert.equal(workerTimeout({}, 'agent', settings, { etaMs: 60_000 }).timeoutMs, 1_200_000, 'a short eta never lowers it');
  assert.equal(workerTimeout({ timeoutMin: 40 }, 'agent', settings).timeoutMs, 2_400_000);
  assert.equal(workerTimeout({}, 'agent', settings, { etaMs: 3_600_000, timeoutMs: 600_000 }).timeoutMs, 600_000, '--timeout wins');
  assert.equal(workerTimeout({}, 'chat', settings, { etaMs: 3_600_000 }).timeoutMs, 300_000);
  assert.deepEqual(validateConfig({ providers: { x: { type: 'openai', baseUrl: 'http://h', fallbackModels: 'a', timeoutMin: 'soon' } }, roles: {} }).length, 2);
});

test('a worker past its limit is stopped and the next provider takes over', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  // only the hanging worker gets a short limit (3s); the one that works keeps the normal limit, so a slow runner can't time it out
  cfg.providers.hang = { type: 'cli', enabled: true, bin: 'agent-hang', write: ['x'], read: ['x'], timeoutMin: 0.05 };
  cfg.providers.ok = { type: 'cli', enabled: true, bin: 'agent-ok', write: ['x'], read: ['x'] };
  const t0 = Date.now();
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['hang', 'ok'] });
  assert.equal(s.winner, 'ok');
  assert.match(s.attempts[0].reason, /^timeout \(\d+m\)/);
  assert.ok(Date.now() - t0 < 40_000, `took ${Date.now() - t0}ms`); // well under the 60s the hanging worker would take
});

// fake OpenAI-compatible API: model "busy" is rate-limited, everything else answers; /models lists free models
const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; }).on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'busy:free' }, { id: 'embed-small:free' }, { id: 'qwen-coder:free' }, { id: 'paid-big' }] }));
    const model = JSON.parse(body).model;
    calls.push(model);
    if (model.startsWith('busy')) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'rate limited' } })); }
    res.end(JSON.stringify({ model, choices: [{ message: { content: `Answer from ${model}, in enough words to count.` } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const api = (extra) => ({ type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: '', ...extra });

test('a rate-limited model falls back to the next model on the same provider; only that model cools down', async () => {
  clearCooldowns(); calls.length = 0;
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.nim = api({ model: 'busy', fallbackModels: ['steady'] });
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['nim'] });
  assert.equal(s.winner, 'nim');
  assert.equal(s.model, 'steady');
  assert.deepEqual(s.attempts.map((a) => [a.model, a.ok]), [['busy', false], ['steady', true]]);
  const cd = getCooldowns();
  assert.ok(cd['nim@busy'], 'the busy model cools down');
  assert.ok(!cd.nim, 'the provider stays usable');
  calls.length = 0;
  await dispatch(cfg, { role: 'ask', task: 'again?', chain: ['nim'] });
  assert.deepEqual(calls, ['steady'], 'the cooling model is skipped next time');
});

test('a free provider with no fallbacks set finds free chat models from its own list', async () => {
  clearCooldowns(); calls.length = 0;
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.freebie = api({ model: 'busy:free', free: true });
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['freebie'] });
  assert.equal(s.model, 'qwen-coder:free', 'skips embedding models and paid ones');
  assert.deepEqual(calls, ['busy:free', 'qwen-coder:free']);
});

test('a paid provider with one model still cools down as a whole', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers.paid = api({ model: 'busy' });
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['paid'] });
  assert.equal(s.winner, null);
  assert.ok(getCooldowns().paid);
});

test('agy gets the same time limit instead of --print-timeout 0', async () => {
  fakeBins({ agy: `console.log('## RESULT: DONE\\n## Notes\\n- args: ' + args.join(' '));` });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers['antigravity-cli'].enabled = true;
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['antigravity-cli'], timeoutMs: 45 * 60_000 });
  const fs = await import('node:fs');
  const report = fs.readFileSync(`${dir}/${s.report}`, 'utf8');
  assert.match(report, /--print-timeout 45m/);
});
