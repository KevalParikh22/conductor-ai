// Chat workers (H7: own prompt, project map, one repair turn) and the edit guard (H6: syntax, contract).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolateHome, makeRepo, PLAN } from './helpers.js';

isolateHome();
const { fileSymbols, repoMap } = await import('../src/context.js');
const { syntaxErrors, contractNames, missingContract } = await import('../src/gates.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const report = '## RESULT: DONE\n## Files changed\n- src/add.js\n## Checks run\n- not run (no tool access)\n## Acceptance\n- [x] 1. add(2, 3) returns 5 — evidence: src/add.js:1\n';
const block = (body) => `<<<FILE src/add.js\n${body}\nFILE>>>\n${report}`;
const REPLIES = {
  // first answer pretends to have tools; the repair turn gets the files
  toolish: (msgs) => (msgs.length > 2 ? block('export const add = (a, b) => a + b;') : "I'll start by reading the relevant files. Let me check the project first."),
  broken: () => block('export const add = (a, b) => { return a + ;'),
  wrongname: () => block('export const sum = (a, b) => a + b;'),
  good: () => block('export const add = (a, b) => a + b;'),
};
let server, port;
const calls = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => body += d).on('end', () => {
      const j = JSON.parse(body); const kind = req.url.split('/')[1];
      calls.push({ kind, messages: j.messages });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: REPLIES[kind](j.messages), reasoning: 'thinking…' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

function cfgFor(dir) {
  const cfg = loadConfig(dir);
  for (const k of Object.keys(REPLIES)) cfg.providers[k] = { type: 'openai', location: 'cloud-api', enabled: true, baseUrl: `http://127.0.0.1:${port}/${k}`, apiKeyEnv: '', model: 'm' };
  return cfg;
}

test('project map lists code files with the names they define, never secrets', () => {
  assert.deepEqual(fileSymbols('export function a() {}\nexport class B {}\nexport const c = 1;\nexport { d, e as f };\nfunction g() {}\ndef h(): pass'), ['a', 'B', 'c', 'd', 'f', 'g', 'h']);
  const { dir } = makeRepo({ files: { 'src/cart.js': 'export function total() {}\n', '.env': 'KEY=1\n', 'README.md': '# x\n' } });
  const map = repoMap(dir);
  assert.match(map, /src\/cart\.js: total/);
  assert.match(map, /other files: .*README\.md/);
  assert.ok(!map.includes('.env'));
});

test('syntax and contract checks', () => {
  const { dir } = makeRepo({ files: { 'src/a.js': 'export const a = (;', 'b.json': '{"x":', 'src/ok.js': 'export class LRUCache { get(k) { return k; }\n  keys() { return []; } }\nexport function toQuery() {}\n' } });
  assert.deepEqual(syntaxErrors(dir, ['src/a.js', 'b.json', 'src/ok.js', 'gone.js']).map((e) => e.file), ['src/a.js', 'b.json']);
  assert.deepEqual(contractNames("- **acceptance:** `toQuery({ b: 2 })` sorts; `new LRUCache(0)` throws; `encodeURIComponent(x)`; `arr.map(f)`; `keys()`"), ['toQuery', 'LRUCache', 'keys']);
  assert.deepEqual(missingContract(dir, '`toQuery(x)` `new LRUCache(2)` `keys()` `parseCSV(t)`'), ['parseCSV']);
});

test('a chat model that answers as if it had tools gets one repair turn, with the chat-only prompt and the project map', async () => {
  clearCooldowns(); calls.length = 0;
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/util.js': 'export function helper() {}\n' } });
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['toolish'] });
  assert.equal(s.winner, 'toolish');
  assert.equal(s.attempts[0].repaired, true);
  assert.deepEqual(s.attempts[0].tokens, { input: 20, output: 10 }, 'both turns counted');
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.match(first.messages[0].content, /you have NO tools/);
  assert.ok(!/Read `AGENTS.md`/.test(first.messages[0].content), 'not the agent instructions');
  assert.match(first.messages[1].content, /# Project map[\s\S]*src\/util\.js: helper/);
  assert.match(first.messages[1].content, /Reply now, in this message/);
  assert.equal(second.messages.length, 4);
  assert.match(second.messages[2].content, /Let me check the project first/);
  assert.match(second.messages[3].content, /had no <<<FILE blocks/);
  assert.match(fs.readFileSync(path.join(dir, s.runDir, 'toolish.log'), 'utf8'), /content \d+ chars · reasoning \d+ chars[\s\S]*==== repair turn ====/);
});

test('the edit guard rejects broken syntax and a missing name, and the next provider runs', async () => {
  clearCooldowns();
  // as conduct-plan writes it: code in backticks
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN.replace('add(2, 3) returns 5', '`add(2, 3)` returns 5') } });
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['broken', 'wrongname', 'good'] });
  assert.deepEqual(s.attempts.map((a) => a.reason), ['syntax error in src/add.js', 'missing from the code: add (the task names it)', 'ok']);
  assert.ok(s.attempts[0].stashed && s.attempts[1].stashed, 'rejected edits are stashed');
  assert.equal(s.winner, 'good');
  assert.equal(fs.readFileSync(path.join(dir, 'src/add.js'), 'utf8').trim(), 'export const add = (a, b) => a + b;');
  assert.equal(s.outcome, 'done');
});
