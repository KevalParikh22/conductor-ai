// Evidence check, open-questions gate, usage and budgets, run history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

const home = isolateHome();
fakeBins({
  // changes src/a.js but claims src/b.js too
  'claims-too-much': `fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/a.js','x');
    console.log('## RESULT: DONE\\n## Files changed\\n- src/a.js — real\\n- src/b.js — not really\\n## Notes\\n- none');`,
  // says DONE, changes nothing
  'idle': `console.log('## RESULT: DONE\\n## Files changed\\n- (none)\\n## Notes\\n- all good already');`,
  // honest
  'honest': `fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/a.js','y'); console.log('## RESULT: DONE\\n## Files changed\\n- \`src/a.js\`: done\\n## Notes\\n- none');`,
});

let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    req.resume().on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'paid-model', usage: { prompt_tokens: 1000, completion_tokens: 500 },
        choices: [{ message: { content: 'The answer is 42, explained in enough words to count.' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const { loadConfig } = await import('../src/config.js');
const { dispatch, clearCooldowns, claimedFiles, checkEvidence, openQuestions, resolveChain, UsageError } = await import('../src/core.js');
const { readUsage, usageReport, budgetBlock, estimateCost, USAGE_FILE } = await import('../src/usage.js');
const { listRuns, readRun } = await import('../src/runs.js');
const { planBatch } = await import('../src/batch.js');

const cli = (bin) => ({ type: 'cli', enabled: true, bin, write: ['x'], read: ['x'] });
function cfgFor(dir, extra = {}) {
  const cfg = loadConfig(dir);
  cfg.providers = { ...cfg.providers, 'claims-too-much': cli('claims-too-much'), idle: cli('idle'), honest: cli('honest'),
    'paid-api': { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: '', model: 'paid-model', price: { input: 2, output: 10 } },
    ...extra };
  cfg.settings = { ...cfg.settings, planGate: false }; // these plans test other things; the plan gate has its own tests
  return cfg;
}

test('claimedFiles reads the "Files changed" list in its usual shapes', () => {
  assert.deepEqual(claimedFiles('## Files changed\n- src/a.js — x\n- `b/c.ts`: y\n* ./d.md\n## Notes\n- src/not-this.js'), ['src/a.js', 'b/c.ts', 'd.md']);
  assert.deepEqual(claimedFiles('## Files changed\n- (none)\n'), []);
  assert.equal(claimedFiles('## RESULT: DONE'), null);
  assert.deepEqual(checkEvidence('## Files changed\n- src/\n', ['src/x.js'], '').warnings, [], 'a listed folder covers files inside it');
});

test('evidence check: claims that git does not back up are flagged', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const s = await dispatch(cfgFor(dir), { role: 'fix', task: 'fix it', chain: ['claims-too-much'], noVerify: true });
  assert.deepEqual(s.evidence.notChanged, ['src/b.js']);
  assert.ok(s.warnings.some((w) => w.includes('says it changed src/b.js')));

  // with --allow-dirty, files modified before the run are not counted for or against the worker
  const dirty = await dispatch(cfgFor(dir), { role: 'fix', task: 'fix it', chain: ['idle'], noVerify: true, allowDirty: true });
  assert.ok(!dirty.warnings.some((w) => w.includes('not listed')), 'earlier changes are not blamed on this worker');

  const clean = makeRepo().dir;
  const idle = await dispatch(cfgFor(clean), { role: 'fix', task: 'fix it', chain: ['idle'], noVerify: true });
  assert.ok(idle.warnings.some((w) => w.includes('reports DONE but changed no files')));
});

test('evidence check: an honest report raises nothing', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const s = await dispatch(cfgFor(dir), { role: 'fix', task: 'fix it', chain: ['honest'], noVerify: true });
  assert.deepEqual(s.evidence, { claimed: ['src/a.js'], notChanged: [], notReported: [] });
  assert.deepEqual(s.warnings, []);
});

const PLAN = (q) => `# Plan: x\n\n## Open questions\n${q}\n\n## Design notes\n- n\n\n## Tasks\n\n### T1: one\n- **role:** fix\n- **files:** \`src/a.js\`\n`;

test('open questions block write tasks until answered', async () => {
  clearCooldowns();
  assert.deepEqual(openQuestions(PLAN('- [ ] <question>')), [], 'the template placeholder does not count');
  assert.deepEqual(openQuestions(PLAN('- [x] which db? → sqlite\n- [ ] keep the old API?')), ['keep the old API?']);
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN('- [ ] keep the old API?') } });
  const cfg = cfgFor(dir);
  await assert.rejects(dispatch(cfg, { role: 'fix', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['honest'] }), (e) => e instanceof UsageError && /open question/.test(e.message));
  assert.throws(() => planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1'] }), /open question/);
  const s = await dispatch(cfg, { role: 'fix', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['honest'], noVerify: true, allowOpenQuestions: true });
  assert.equal(s.winner, 'honest');
  fs.writeFileSync(path.join(dir, 'docs/plan/p.md'), PLAN('- [x] keep the old API? → yes'));
  assert.equal(planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1'] }).items.length, 1);
});

test('usage: tokens and cost are recorded; a daily budget stops paid providers only', async () => {
  clearCooldowns();
  fs.rmSync(USAGE_FILE(), { force: true });
  const { dir } = makeRepo();
  const s = await dispatch(cfgFor(dir), { role: 'ask', task: 'what is it?', chain: ['paid-api'] });
  assert.deepEqual(s.attempts[0].tokens, { input: 1000, output: 500 });
  assert.equal(s.attempts[0].cost, (1000 * 2 + 500 * 10) / 1e6);
  const u = readUsage();
  assert.equal(u.length, 1);
  assert.equal(u[0].provider, 'paid-api');
  assert.equal(usageReport(1).rows[0].input, 1000);

  assert.equal(estimateCost({ free: true }, { input: 9, output: 9 }), 0);
  assert.equal(estimateCost({}, { input: 9, output: 9 }), null, 'no price: unknown, not zero');

  const cfg = cfgFor(dir);
  cfg.settings.dailyBudgetUSD = 0.005;
  assert.match(budgetBlock('paid-api', cfg.providers['paid-api'], cfg.settings), /daily budget reached/);
  assert.equal(budgetBlock('kilo-free', cfg.providers['kilo-free'], cfg.settings), null, 'free providers are never blocked');
  const chain = resolveChain(cfg, 'ask', { chain: ['paid-api', 'honest'] });
  assert.match(chain[0].skip, /daily budget/);
  assert.equal(chain[1].skip, undefined);
});

test('run history lists runs newest first with their outcome', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  await dispatch(cfgFor(dir), { role: 'fix', task: 'a', chain: ['honest'], noVerify: true });
  await new Promise((r) => setTimeout(r, 1100)); // run folders are named by the second
  await dispatch(cfgFor(dir), { role: 'fix', task: 'b', chain: ['idle'], noVerify: true, allowDirty: true });
  const rows = listRuns(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].winner, 'idle');
  assert.deepEqual(rows[0].warnings, [], 'its tree was already dirty, so nothing is blamed on it');
  assert.equal(rows[1].winner, 'honest');
  assert.equal(rows[1].changed, 1);
  assert.ok(rows[1].startedAt);
  assert.equal(readRun(dir, rows[1].id).summary.winner, 'honest');
  assert.equal(readRun(dir, 'nope'), null);
});

test('an API provider that answers 200 with no content is asked once more', async () => {
  clearCooldowns();
  let calls = 0;
  const flaky = http.createServer((req, res) => {
    req.resume().on('end', () => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: calls === 1 ? '' : 'Second try worked, with enough words.' } }] }));
    });
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  const { dir } = makeRepo();
  const cfg = cfgFor(dir, { flaky: { type: 'openai', location: 'cloud-api', enabled: true, baseUrl: `http://127.0.0.1:${flaky.address().port}/v1`, apiKeyEnv: '', model: 'm', free: true } });
  const s = await dispatch(cfg, { role: 'ask', task: 'what?', chain: ['flaky'] });
  flaky.close();
  assert.equal(s.winner, 'flaky');
  assert.equal(calls, 2);
});
