// Q6: independent review by another model family, for risky work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { modelFamily, riskReasons, parseFindings, keepInDiff, changedRanges } = await import('../src/review.js');
const { dispatch, formatSummary, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const REVIEW = `## Findings
1. [severity: high] [confidence: high] \`src/auth/login.js:2\`: compares passwords with == instead of a constant-time check
   - scenario: timing attack on login
   - fix: use crypto.timingSafeEqual
2. [severity: medium] [confidence: low] \`src/other.js:40\`: unrelated code
## VERDICT: CHANGES_REQUESTED
`;
let server, port; const seen = [];
before(async () => {
  server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => b += d).on('end', () => {
    seen.push(JSON.parse(b));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: REVIEW } }] }));
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port;
});
after(() => server.close());

test('model families: from the model id, else the CLI; unknown never counts as different', () => {
  assert.equal(modelFamily('codex-cli', { preset: 'codex' }), 'openai');
  assert.equal(modelFamily('antigravity-cli', { preset: 'antigravity' }), 'google');
  assert.equal(modelFamily('kilo-free', {}, 'qwen/qwen3-coder:free'), 'qwen');
  assert.equal(modelFamily('openrouter-free', { model: 'google/gemma-3:free' }), 'google');
  assert.equal(modelFamily('opencode', { preset: 'opencode', model: 'opencode/big-pickle' }), 'unknown:opencode');
});

test('risk: big diffs, security-related files, or the plan asks', () => {
  assert.deepEqual(riskReasons({ changed: ['src/a.js'], lines: 20 }), []);
  assert.match(riskReasons({ changed: ['src/a.js'], lines: 400 }).join(), /400 lines changed \(over 150\)/);
  assert.match(riskReasons({ changed: ['src/auth/login.js', 'db/query.ts'], lines: 5 }).join(), /security-related files: src\/auth\/login\.js, db\/query\.ts/);
  assert.match(riskReasons({ changed: [], lines: 1, section: '- **review:** yes' }).join(), /the plan asks/);
  assert.deepEqual(riskReasons({ changed: [], lines: 999, settings: { reviewLines: 0 } }), [], 'reviewLines: 0 turns the size rule off');
});

test('findings are parsed; only those on changed lines are kept', () => {
  const { dir, git } = makeRepo({ files: { 'src/a.js': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' } });
  const base = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\neight\nnine\nten\n');
  fs.writeFileSync(path.join(dir, 'src/new.js'), 'x\n');
  const ranges = changedRanges(dir, base);
  assert.deepEqual(ranges['src/a.js'], [[7, 7]]);
  const f = parseFindings('## Findings\n1. [severity: high] [confidence: high] `src/a.js:8`: near the change\n2. [severity: low] `src/a.js:1`: far away\n3. `src/new.js:1`: new file\n4. no location at all\n## VERDICT: APPROVE');
  assert.deepEqual(f.map((x) => [x.file, x.line, x.severity]), [['src/a.js', 8, 'high'], ['src/a.js', 1, 'low'], ['src/new.js', 1, 'unknown'], [null, null, 'unknown']]);
  const { kept, dropped } = keepInDiff(f, ranges);
  assert.deepEqual([kept.map((x) => x.n), dropped.length], [[1, 3], 2]);
});

const PLAN = `# Plan
## Open questions
- [x] none
## Tasks
### T1: login check
- **role:** build
- **files:** \`src/auth/login.js\`
- **acceptance:**
  - [ ] \`check('a', 'a')\` returns true
`;
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/auth/login.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. check — evidence: src/auth/login.js:2\\n';
fakeBins({ 'rv-worker': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.mkdirSync('src/auth',{recursive:true});fs.writeFileSync('src/auth/login.js','// login\\nexport const check = (a, b) => a == b;\\n');fs.writeFileSync(o,'${REPORT}');});` });
const cfgFor = (dir, reviewerModel) => {
  const cfg = loadConfig(dir);
  cfg.providers.worker = { type: 'cli', preset: 'codex', enabled: true, bin: 'rv-worker' }; // openai family
  cfg.providers.judge = { type: 'openai', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: '', model: reviewerModel };
  cfg.settings = { ...cfg.settings, reviewers: ['judge'] };
  return cfg;
};
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } }).dir;

test('security-related work is reviewed by another family; findings off the diff are dropped; the outcome stays done', async () => {
  clearCooldowns(); seen.length = 0;
  const s = await dispatch(cfgFor(repo(), 'google/gemini-x'), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['worker'] });
  assert.equal(s.outcome, 'done', 'advisory: it never overrides passing checks');
  assert.deepEqual([s.review.reviewer, s.review.family, s.review.workerFamily, s.review.verdict], ['judge', 'google', 'openai', 'CHANGES_REQUESTED']);
  assert.deepEqual(s.review.findings.map((f) => `${f.file}:${f.line}`), ['src/auth/login.js:2']);
  assert.equal(s.review.dropped, 1);
  assert.match(seen[0].messages[1].content, /Another model \(worker, openai\) did the task[\s\S]*```diff[\s\S]*a == b/);
  assert.match(formatSummary(s), /review: +judge \(google, the worker is openai\) because security-related files: src\/auth\/login\.js: CHANGES_REQUESTED, 1 finding\(s\) on changed lines \(1 dropped[\s\S]*! \[high\] src\/auth\/login\.js:2 compares passwords/);
});

test('no reviewer from another family: skipped and said so; --no-review skips it', async () => {
  clearCooldowns();
  let s = await dispatch(cfgFor(repo(), 'openai/gpt-x'), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['worker'] });
  assert.match(s.review.skipped, /no ready reviewer from another model family than openai/);
  assert.match(formatSummary(s), /review: +not done \(no ready reviewer/);
  s = await dispatch(cfgFor(repo(), 'google/gemini-x'), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['worker'], noReview: true });
  assert.equal(s.review, undefined);
});
