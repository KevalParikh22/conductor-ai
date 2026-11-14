// V2: every failure reason comes with a next step the user can act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { nextStep, fixLines, isLasting } = await import('../src/nextsteps.js');
const { dispatch, clearCooldowns, formatSummary } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { listRuns, formatRuns } = await import('../src/runs.js');

const FALLBACK = /^read the worker log in the run folder, then/;
// every reason the code writes, in the exact shape it writes it
const REASONS = {
  'unknown provider': /isn't configured/,
  disabled: /turn x on/,
  '"agy" not installed': /install it: curl .*antigravity.*sign in: agy/,
  'not installed': /install it/,
  'GROQ_API_KEY not set': /conductor keys set GROQ_API_KEY.*get one at https:/,
  'GROQ_API_KEY not set (placeholder value)': /conductor keys set GROQ_API_KEY/,
  'cooling down until 10:42:00 (rate limited)': /until 10:42:00.*conductor cooldown --clear x/,
  'daily budget reached ($1.00 of $1)': /dailyBudgetUSD/,
  'every model is cooling down': /conductor cooldown --clear x/,
  cancelled: /passed first/,
  'context too small: the prompt needs ~9000 tokens with the answer, qwen3.5:2b runs with 4096 (Ollama 0.40.13)': /OLLAMA_CONTEXT_LENGTH=16384/,
  'quota (cooldown 30m)': /rate limit or its quota/,
  'denied: command (add an allow rule, e.g. settings.allowCommands)': /refused `command`.*allowCommands/,
  'agy status ERROR': /Antigravity reported an error: read run\/x\.log/,
  'auth (401)': /conductor keys set GROQ_API_KEY/,
  'idle (no output for 5m)': /idleTimeoutMin/,
  'timeout (20m)': /--timeout 45m.*eta:/,
  timeout: /ran out of time/,
  'spawn error': /couldn't start/,
  'network: ECONNREFUSED': /connection and its base URL/,
  'server 503': /on its side/,
  'server overloaded': /on its side/,
  'http 404': /conductor models x/,
  'no model set, and its model list could not be fetched': /set a model for x/,
  'no file blocks in reply': /give this task to an agent/,
  'only protected/outside files returned': /give this task to an agent/,
  'syntax error in src/a.js': /src\/a\.js doesn't parse/,
  'missing from the code: add (the task names it)': /didn't write add/,
  'not exported by name: add (the task needs `export` under exactly that name)': /add `export` for add/,
  'empty output': /returned nothing usable: read run\/x\.log/,
  'empty output: jetski: signed out': /returned nothing usable/,
  'exit 1': /stopped with an error: read run\/x\.log/,
  'unexpected reply': /not as asked/,
};

test('every reason the code writes maps to its own next step, never the generic fallback', () => {
  const ctx = { name: 'x', p: { preset: 'antigravity', bin: 'agy', apiKeyEnv: 'GROQ_API_KEY' }, log: 'run/x.log' };
  for (const [reason, want] of Object.entries(REASONS)) {
    const step = nextStep(reason, ctx);
    assert.doesNotMatch(step, FALLBACK, `"${reason}" has no step of its own`);
    assert.match(step, want, `"${reason}" → ${step}`);
  }
  assert.equal(nextStep('ok'), '');
  assert.match(nextStep('something new'), FALLBACK, 'an unknown reason still says where to look');
});

test('source scan: each literal reason in src/ has a sample above, so it is covered by the table', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const found = new Set();
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of text.matchAll(/reason: (?:'([^']+)'|`([^`$]*)\$?)/g)) {
      const lit = m[1] ?? m[2];
      if (lit && !/^(ok|installed|ready|key present|no key needed|responded)/.test(lit)) found.add(lit.trim());
    }
  }
  assert.ok(found.size >= 8, `found ${found.size} literal reasons`);
  for (const lit of found) {
    if (!/^[a-z]/i.test(lit)) continue; // a reason that starts with a value (e.g. `${env} not set`) is in REASONS above
    assert.ok(Object.keys(REASONS).some((r) => r.startsWith(lit)), `reason "${lit}…" (in src/) needs a row in src/nextsteps.js and a sample in REASONS`);
  }
});

test('lasting problems are flagged even when another worker won; passing ones only when nothing won', () => {
  for (const r of ['"agy" not installed', 'GROQ_API_KEY not set', 'auth (401)', 'denied: command (x)', 'disabled', 'http 404']) assert.ok(isLasting(r), r);
  for (const r of ['quota', 'timeout (5m)', 'exit 1', 'server 503', 'cooling down until 1:00 (x)']) assert.ok(!isLasting(r), r);
  const attempts = [
    { provider: 'a', ok: false, reason: 'GROQ_API_KEY not set', next: 'set the key' },
    { provider: 'b', ok: false, reason: 'quota', next: 'cools down' },
    { provider: 'b', ok: false, reason: 'quota', next: 'cools down' },
    { provider: 'c', ok: true, reason: 'ok' },
  ];
  assert.deepEqual(fixLines(attempts), ['a: set the key', 'b: cools down'], 'one line per provider');
  assert.deepEqual(fixLines(attempts, { won: true }), ['a: set the key']);
});

test('a failed run says what to do per provider, in the summary, conductor runs and the run list', async () => {
  fakeBins({ 'oops-bin': 'console.error("boom"); process.exit(1);' });
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers = {
    broken: { type: 'cli', enabled: true, bin: 'oops-bin', write: ['{prompt}'], read: ['{prompt}'] },
    missing: { type: 'cli', preset: 'codex', enabled: true, bin: 'no-such-codex' },
  };
  const s = await dispatch(cfg, { role: 'ask', task: 'q', chain: ['missing', 'broken'] });
  assert.equal(s.winner, null);
  assert.match(s.attempts.find((a) => a.provider === 'broken').next, /stopped with an error: read \.conductor\/runs\/.+\/broken\.log/);
  const text = formatSummary(s);
  assert.match(text, /fix: {7}missing: install it: npm install -g @openai\/codex, sign in: codex login/);
  assert.match(text, /fix: {7}broken: the worker stopped with an error/);
  const rows = listRuns(dir);
  assert.equal(rows[0].fixes.length, 2);
  assert.match(formatRuns(rows), /fix: missing: install it/);
});
