// H8: Anthropic prompt caching (cache_control breakpoints on the stable prefix), its fallback and its usage numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isolateHome, makeRepo, PLAN } from './helpers.js';

isolateHome();
const { runAnthropic, anthropicTokens, CACHE_MIN_CHARS } = await import('../src/providers.js');
const { estimateCost } = await import('../src/usage.js');
const { formatSummary } = await import('../src/summary.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const report = '## RESULT: DONE\n## Files changed\n- src/add.js\n## Checks run\n- not run (no tool access)\n## Acceptance\n- [x] 1. add(2, 3) returns 5 — evidence: src/add.js:1\n';
const usage = { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 };
let server, port;
const calls = [];
before(async () => {
  process.env.FAKE_ANTHROPIC_KEY = 'k';
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => body += d).on('end', () => {
      const j = JSON.parse(body); const kind = req.url.split('/')[1];
      calls.push({ kind, url: req.url, body: j });
      if (kind === 'strict' && body.includes('cache_control')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Extra inputs are not permitted: cache_control"}}');
      }
      // toolish: the first answer has no file blocks, so the run asks again (repair turn)
      const text = kind === 'toolish' && j.messages.length === 1 ? 'Let me read the files first.' : `<<<FILE src/add.js\nexport const add = (a, b) => a + b;\nFILE>>>\n${report}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }], usage }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const prov = (kind, extra = {}) => ({ type: 'anthropic', baseUrl: `http://127.0.0.1:${port}/${kind}`, apiKeyEnv: 'FAKE_ANTHROPIC_KEY', model: 'm', ...extra });
const long = 'x'.repeat(CACHE_MIN_CHARS);

test('a long stable prefix gets cache breakpoints on system and context; the task is a separate block', async () => {
  calls.length = 0;
  const prompt = `${long}\n---\n# TASK\ndo it`;
  const r = await runAnthropic('a1', prov('ok'), { system: long, prompt, stableChars: long.length, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  const { body } = calls[0];
  assert.deepEqual(body.system, [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }, { type: 'text', text: '\n---\n# TASK\ndo it' }]);
});

test('a short prompt is sent as plain strings, as before', async () => {
  calls.length = 0;
  await runAnthropic('a2', prov('ok'), { system: 'sys', prompt: 'ctx\n---\ntask', stableChars: 3, timeoutMs: 5000 });
  assert.equal(calls[0].body.system, 'sys');
  assert.equal(calls[0].body.messages[0].content, 'ctx\n---\ntask');
  assert.ok(!JSON.stringify(calls[0].body).includes('cache_control'));
});

test('promptCache: false turns the breakpoints off', async () => {
  calls.length = 0;
  await runAnthropic('a3', prov('ok', { promptCache: false }), { system: long, prompt: `${long}task`, stableChars: long.length, timeoutMs: 5000 });
  assert.ok(!JSON.stringify(calls[0].body).includes('cache_control'));
});

test('a gateway that rejects cache_control gets the request again without it, and never again in this process', async () => {
  calls.length = 0;
  const req = { system: long, prompt: `${long}task`, stableChars: long.length, timeoutMs: 5000 };
  const r = await runAnthropic('strict', prov('strict'), req);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(JSON.stringify(calls[0].body).includes('cache_control'));
  assert.ok(!JSON.stringify(calls[1].body).includes('cache_control'));
  assert.match(r.log, /refused cache_control/);
  await runAnthropic('strict', prov('strict'), req);
  assert.equal(calls.length, 3, 'remembered: one call, no breakpoints');
});

test('cache reads and writes are counted, priced and shown', () => {
  const t = anthropicTokens(usage);
  assert.deepEqual(t, { input: 1050, output: 7, cacheRead: 900, cacheWrite: 100 });
  assert.deepEqual(anthropicTokens({ input_tokens: 5, output_tokens: 1 }), { input: 5, output: 1 });
  // 50 + 900*0.1 + 100*1.25 = 265 input-priced tokens
  assert.equal(estimateCost({ price: { input: 1e6, output: 0 } }, t), 265);
  const s = { role: 'build', status: 'done', winner: 'a', model: 'm', attempts: [{ provider: 'a', ok: true, tokens: t, cost: 1 }], warnings: [], changed: [], applied: [], rejected: [], runDir: 'x', exitCode: 0 };
  assert.match(formatSummary(s), /1050 tokens in \(cache: 900 read, 100 written\) \/ 7 out/);
});

test('a repair turn reuses the same cached prefix (system and context blocks unchanged)', async () => {
  clearCooldowns(); calls.length = 0;
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/util.js': `export function helper() {}\n// ${long}\n` } });
  const cfg = loadConfig(dir);
  cfg.providers.toolish = { ...prov('toolish'), location: 'cloud-api', enabled: true };
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['toolish'], files: ['src/util.js'] });
  assert.equal(s.attempts[0].repaired, true);
  assert.deepEqual(s.attempts[0].tokens, { input: 2100, output: 14, cacheRead: 1800, cacheWrite: 200 }, 'both turns, cache fields kept');
  const [first, second] = calls;
  assert.equal(second.body.messages.length, 3);
  assert.deepEqual(second.body.system, first.body.system);
  assert.deepEqual(second.body.messages[0], first.body.messages[0]);
  const [ctx, task] = first.body.messages[0].content;
  assert.ok(ctx.cache_control && !task.cache_control);
  assert.match(ctx.text, /src\/util\.js/);
  assert.ok(!ctx.text.includes('# TASK'), 'the task is not in the cached part');
  assert.match(task.text, /^\n---\n# TASK/);
});
