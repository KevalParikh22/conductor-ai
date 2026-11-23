// Chat-model <<<EDIT blocks: SEARCH/REPLACE hunks for an existing file instead of the whole file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolateHome, tmpdir, makeRepo, PLAN } from './helpers.js';

isolateHome();
const { parseFileBlocks, applyFileBlocks, applyEdits } = await import('../src/files.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const hunk = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;
const edit = (p, ...hunks) => `<<<EDIT ${p}\n${hunks.join('')}EDIT>>>\n`;
const repo = (files) => { const root = path.join(tmpdir(), 'repo'); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); } return root; };
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

test('one and several hunks apply in order', () => {
  const root = repo({ 'a.js': 'one\ntwo\nthree\nfour\n' });
  const blocks = parseFileBlocks(`intro\n${edit('a.js', hunk('two', 'TWO'), hunk('TWO\nthree', 'TWO\n3'))}## RESULT: DONE`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].edits.length, 2);
  const r = applyFileBlocks(root, blocks);
  assert.deepEqual(r.applied, ['a.js']);
  assert.deepEqual(r.edits.map((e) => [e.path, e.hunks]), [['a.js', 2]]);
  assert.equal(read(root, 'a.js'), 'one\nTWO\n3\nfour\n');
  // an empty REPLACE deletes; the last line without a newline still matches
  assert.deepEqual(applyEdits('a\nb\nc', [{ search: 'b\n', replace: '' }, { search: 'c\n', replace: 'C\n' }]), { text: 'a\nC' });
});

test('no match, or two matches, rejects the whole file and writes nothing', () => {
  const before = 'x = 1\ny = 2\nx = 1\n';
  const root = repo({ 'a.py': before, 'b.py': 'b\n' });
  const r = applyFileBlocks(root, parseFileBlocks(edit('a.py', hunk('y = 2', 'y = 3'), hunk('x = 1', 'x = 9')) + edit('b.py', hunk('nope', 'x'))));
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.rejected, ['a.py (SEARCH 2 matches more than once)', 'b.py (SEARCH 1 not found)']);
  assert.equal(read(root, 'a.py'), before, 'the first hunk was not written either');
  assert.deepEqual(applyFileBlocks(root, parseFileBlocks('<<<EDIT b.py\njust text\nEDIT>>>\n')).rejected, ['b.py (EDIT block has no SEARCH/REPLACE hunks)']);
  assert.deepEqual(applyFileBlocks(root, parseFileBlocks(edit('b.py', hunk('b\n=======\nc', 'x')))).rejected, ['b.py (hunk 1 has two ======= lines)']);
  assert.match(applyFileBlocks(root, parseFileBlocks(edit('new.py', hunk('a', 'b')))).rejected[0], /new\.py \(EDIT on a file that doesn't exist/);
});

test('a CRLF file matches LF hunks and stays CRLF', () => {
  const root = repo({ 'w.txt': 'a\r\nb\r\nc\r\n' });
  applyFileBlocks(root, parseFileBlocks(edit('w.txt', hunk('b\nc', 'B\nc'))));
  assert.equal(read(root, 'w.txt'), 'a\r\nB\r\nc\r\n');
});

test('a file with mixed line endings keeps them outside the hunk', () => {
  // the unchanged CRLF and LF lines stay as they are; replaced lines take the ending of the line they start on
  assert.deepEqual(applyEdits('a\r\nb\nc\r\nd\n', [{ search: 'c\nd\n', replace: 'C\nD\nE\n' }]), { text: 'a\r\nb\nC\r\nD\r\nE\r\n' });
  assert.deepEqual(applyEdits('a\r\nb\nc\r\n', [{ search: 'b\n', replace: 'B\nB2\n' }]), { text: 'a\r\nB\nB2\nc\r\n' });
  // a hunk that starts mid-line; the last line without a newline
  assert.deepEqual(applyEdits('x = 1\r\ny = 2\nz', [{ search: '1\ny', replace: '9\nw' }, { search: 'z\n', replace: 'Z\n' }]), { text: 'x = 9\r\nw = 2\nZ' });
});

test('edits get the same path checks as whole files', () => {
  const root = repo({ 'AGENTS.md': 'rules\n', 'src/ok.js': 'x\n' });
  fs.writeFileSync(path.join(root, '..', 'outside-edit.js'), 'x\n');
  const r = applyFileBlocks(root, parseFileBlocks(edit('AGENTS.md', hunk('rules', 'none')) + edit('../outside-edit.js', hunk('x', 'y')) + edit('/etc/hosts', hunk('a', 'b'))));
  assert.deepEqual(r.rejected, ['AGENTS.md (protected)', '../outside-edit.js (outside repo)', '/etc/hosts (outside repo)']);
  assert.equal(read(root, 'AGENTS.md'), 'rules\n');
  assert.equal(fs.readFileSync(path.join(root, '..', 'outside-edit.js'), 'utf8'), 'x\n');
});

test('a reply can mix FILE and EDIT blocks, in order', () => {
  const root = repo({ 'src/big.js': 'const a = 1;\nconst b = 2;\n' });
  const text = `<<<FILE src/new.js\nexport const n = 1;\nFILE>>>\n${edit('src/big.js', hunk('const b = 2;', 'const b = 3;'))}<<<FILE src/new2.js\nx\nFILE>>>\n`;
  const blocks = parseFileBlocks(text);
  assert.deepEqual(blocks.map((b) => [b.path, b.edits ? 'edit' : 'file']), [['src/new.js', 'file'], ['src/big.js', 'edit'], ['src/new2.js', 'file']]);
  const r = applyFileBlocks(root, blocks);
  assert.deepEqual(r.applied, ['src/new.js', 'src/big.js', 'src/new2.js']);
  assert.equal(read(root, 'src/big.js'), 'const a = 1;\nconst b = 3;\n');
});

// ---------------- end to end: a chat model edits a long file ----------------
const LONG = `${Array.from({ length: 1200 }, (_, i) => `export const filler${i} = ${i}; // padding line ${i}`).join('\n')}\nexport const add = (a, b) => a - b;\n`;
const report = '## RESULT: DONE\n## Files changed\n- src/add.js\n## Checks run\n- not run (no tool access)\n## Acceptance\n- [x] 1. add(2, 3) returns 5 — evidence: src/add.js:1201\n';
const good = edit('src/add.js', hunk('export const add = (a, b) => a - b;', 'export const add = (a, b) => a + b;')) + report;
const REPLIES = {
  edits: () => good,
  // the first SEARCH has the wrong spacing; the repair turn sends it right
  badsearch: (msgs) => (msgs.length > 2 ? good : edit('src/add.js', hunk('export const add = (a,b) => a - b;', 'export const add = (a, b) => a + b;')) + report),
};
let server, port;
const calls = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => body += d).on('end', () => {
      const j = JSON.parse(body); const kind = req.url.split('/')[1];
      calls.push({ kind, messages: j.messages });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: REPLIES[kind](j.messages) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
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

test('a chat model edits a long file with one hunk; the run counts it', async () => {
  clearCooldowns(); calls.length = 0;
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/add.js': LONG } });
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['edits'] });
  assert.equal(s.winner, 'edits');
  assert.equal(s.exitCode, 0);
  assert.deepEqual(s.applied, ['src/add.js']);
  assert.equal(fs.readFileSync(path.join(dir, 'src/add.js'), 'utf8'), LONG.replace('a - b', 'a + b'));
  assert.deepEqual({ ...s.attempts[0].edits, savedChars: undefined }, { files: 1, hunks: 1, savedChars: undefined });
  assert.ok(s.attempts[0].edits.savedChars > 50000, 'the whole file was not resent');
  assert.ok(s.tokensSaved['edit-blocks'] > 10000);
  assert.match(calls[0].messages[0].content, /<<<EDIT relative\/path/, 'the system prompt explains EDIT');
});

test('a SEARCH that does not match gets one repair turn that shows why', async () => {
  clearCooldowns(); calls.length = 0;
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/add.js': LONG } });
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['badsearch'] });
  assert.equal(s.winner, 'badsearch');
  assert.equal(s.attempts[0].repaired, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[3].content, /src\/add\.js \(SEARCH 1 not found\)/);
  assert.deepEqual(s.rejected, [], 'the repaired file is no longer listed as rejected');
  assert.match(fs.readFileSync(path.join(dir, 'src/add.js'), 'utf8'), /a \+ b;\n$/);
});
