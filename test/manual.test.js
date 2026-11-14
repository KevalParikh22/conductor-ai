// W1: the manual web bridge. A run with --provider manual writes the prompt and waits; `conductor import` replays the
// user's answer through every check. conductor never drives a browser or holds a web account (decided 2026-11-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, tmpdir } from './helpers.js';

isolateHome();
const { dispatch, formatSummary, outcome, EXIT_WAITING } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { importAnswer, importResearch, ImportError } = await import('../src/manual.js');
const { listRuns, runDetail } = await import('../src/runs.js');
const { createUiServer } = await import('../src/ui/server.js');

const PLAN = `# Plan
## Open questions
- [x] none
## Tasks
### T1: add
- **role:** build
- **files:** \`src/add.js\`
- **acceptance:**
  - [ ] \`add(2, 3)\` returns \`5\`
`;
const ANSWER = '<<<FILE src/add.js\nexport const add = (a, b) => a + b;\nFILE>>>\n<<<FILE AGENTS.md\nnew rules\nFILE>>>\n## RESULT: DONE\n## Files changed\n- src/add.js\n## Checks run\n- none\n## Acceptance\n- [x] 1. `add(2, 3)` returns `5` — evidence: src/add.js:1\n## Notes\n- none\n';
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const runId = (s) => s.runDir.split('/').pop();

test('a manual run writes the whole prompt and waits (exit 5); nothing is sent anywhere', async () => {
  const { dir } = repo();
  const s = await dispatch(loadConfig(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', provider: 'manual' });
  assert.equal(s.exitCode, EXIT_WAITING);
  assert.equal(outcome(s), 'waiting');
  const prompt = fs.readFileSync(path.join(dir, s.waiting.prompt), 'utf8');
  assert.match(prompt, /### T1: add[\s\S]*<<<FILE/, 'the task and the file-block format a chat needs');
  assert.ok(!/usually Claude/.test(prompt), 'no Claude-only wording');
  assert.ok(fs.existsSync(path.join(dir, s.runDir, 'request.json')));
  assert.match(formatSummary(s), /waiting: +for your answer \(exit 5\)[\s\S]*conductor import \S+ <answer file>/);
  assert.equal(listRuns(dir)[0].state, 'waiting');
  assert.match(runDetail(dir, runId(s)).waiting.promptText, /### T1: add/, 'the run page can copy it');
});

test('importing a write answer: file blocks applied, protected files rejected, every check runs; the run points at it', async () => {
  const { dir } = repo();
  const cfg = loadConfig(dir);
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', provider: 'manual' });
  const n = await importAnswer(cfg, runId(s), ANSWER, { dispatch });
  assert.equal(n.winner, 'manual');
  assert.deepEqual(n.applied, ['src/add.js']);
  assert.match(n.rejected.join(), /AGENTS\.md/);
  assert.equal(n.verify.status, 'PASS');
  assert.equal(n.checks.passed, 1);
  assert.equal(outcome(n), 'done');
  assert.equal(listRuns(dir).find((r) => r.id === runId(s)).state, 'answered');
  await assert.rejects(importAnswer(cfg, runId(s), ANSWER, { dispatch }), (e) => e instanceof ImportError && /already has its answer/.test(e.message));
  await assert.rejects(importAnswer(cfg, runId(n), ANSWER, { dispatch }), /isn't waiting/);
  await assert.rejects(importAnswer(cfg, 'nope', ANSWER, { dispatch }), /no run "nope"/);
});

test('a read answer becomes the report; an empty answer is refused; a prompt over the chat\'s limit is not written', async () => {
  const { dir } = repo();
  const cfg = loadConfig(dir);
  const s = await dispatch(cfg, { role: 'ask', task: 'what does this project do?', provider: 'manual' });
  await assert.rejects(importAnswer(cfg, runId(s), '   ', { dispatch }), /empty/);
  const n = await importAnswer(cfg, runId(s), '## Findings\nIt is a tiny demo project.\n## VERDICT: n/a', { dispatch });
  assert.match(fs.readFileSync(path.join(dir, n.report), 'utf8'), /tiny demo project/);
  cfg.providers.manual = { ...cfg.providers.manual, maxPromptChars: 200, label: 'Tiny chat' };
  const big = await dispatch(cfg, { role: 'ask', task: 'q', provider: 'manual' });
  assert.match(big.attempts[0].reason, /^prompt too long for Tiny chat: \d+ characters, its limit is 200/);
  assert.match(big.attempts[0].next, /smaller task/);
});

test('research reports are filed into the project; a path outside it is refused', () => {
  const { dir } = repo();
  const src = path.join(tmpdir(), 'deep-research.md');
  fs.writeFileSync(src, '# Findings\n- one\n');
  const rel = importResearch(dir, src);
  assert.equal(rel, 'docs/research/deep-research.md');
  assert.match(fs.readFileSync(path.join(dir, rel), 'utf8'), /a web chat's research, check it[\s\S]*# Findings/);
  assert.throws(() => importResearch(dir, src, '../outside.md'), /inside the project/);
});

test('the UI imports an answer for a waiting run, like the CLI', async () => {
  const { dir } = repo();
  const s = await dispatch(loadConfig(dir), { role: 'ask', task: 'q', provider: 'manual' });
  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/import`, { method: 'POST', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r = await (await post({ run: runId(s), text: 'An answer from a web chat.\n## VERDICT: n/a' })).json();
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    assert.ok(r.run && r.run !== runId(s));
    assert.equal((await post({ run: runId(s), text: 'again' })).status, 400);
  } finally { ui.server.closeAllConnections?.(); ui.server.close(); }
});

test('loadConfig returns a fresh copy: changing one config never changes the next load (the UI and MCP servers live long)', () => {
  const { dir } = repo();
  const a = loadConfig(dir);
  a.settings.timeoutSec = 1;
  a.providers['kilo-free'].model = 'changed';
  a.roles.build.push('x');
  const b = loadConfig(dir);
  assert.notEqual(b.settings.timeoutSec, 1);
  assert.notEqual(b.providers['kilo-free'].model, 'changed');
  assert.ok(!b.roles.build.includes('x'));
});
