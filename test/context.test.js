// Q2: the context pack, and per-provider prompt additions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { callersOf, architectureExcerpt, contextPack } = await import('../src/context.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const FILES = {
  'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }),
  'src/cart.js': "export function total(lines) { return lines.reduce((t, l) => t + l.price, 0); }\nexport const EMPTY = [];\n",
  'src/checkout.js': "import { total } from './cart.js';\nexport function pay(cart) { return charge(total(cart.lines)); }\n",
  'src/report.js': "import { total } from './cart.js';\nconst t = total([]);\n",
  'test/cart.test.js': "import { total } from '../src/cart.js';\ntotal([]);\n",
  '.env': 'total=secret\n',
  'docs/architecture.md': '# Architecture\n\n## Payments\nsrc/cart.js holds totals; checkout charges them.\n\n## Search\nUnrelated.\n',
  'lib/other.js': 'export const x = 1;\n',
};

test('callers: where the task files\' names are used, never in the file itself, secrets or non-code', () => {
  const { dir } = makeRepo({ files: FILES });
  const c = callersOf(dir, ['src/cart.js']);
  assert.deepEqual([...new Set(c.map((x) => x.file))], ['src/checkout.js', 'src/report.js', 'test/cart.test.js']);
  assert.ok(c.every((x) => x.name === 'total'));
  assert.match(architectureExcerpt(dir, ['src/cart.js']), /^## Payments\nsrc\/cart\.js holds totals/);
  assert.ok(!architectureExcerpt(dir, ['src/cart.js']).includes('Search'));
});

test('agents get it compact (grouped callers, a map of the task\'s area); chat gets code lines, without imports, source before tests', () => {
  const { dir } = makeRepo({ files: FILES });
  const a = contextPack(dir, { files: ['src/cart.js', 'src/new.js'], verifyCmd: 'npm test', kind: 'agent' });
  assert.match(a, /- \*\*Verify\*\* \(must pass before DONE\): `npm test`/);
  assert.match(a, /`src\/cart\.js` \(\d+ B\): total, EMPTY\n  - `src\/new\.js`: new file/);
  assert.match(a, /- `src\/checkout\.js`: total:1,2\n/);
  assert.match(a, /docs\/architecture\.md\*\* has notes on these files: read the sections on src/);
  assert.match(a, /Project map[\s\S]*src\/checkout\.js: pay/);
  assert.ok(!/lib\/other\.js/.test(a), 'the map covers the task\'s area only');
  const c = contextPack(dir, { files: ['src/cart.js'], kind: 'chat' });
  const uses = c.split('Used elsewhere')[1];
  assert.match(uses, /`src\/checkout\.js:2`: `export function pay\(cart\) \{ return charge\(total\(cart\.lines\)\); \}`/);
  assert.ok(!/import \{ total \}/.test(uses), 'import lines are left out');
  assert.ok(uses.indexOf('src/report.js') < uses.indexOf('test/cart.test.js'), 'source before tests');
  assert.match(c, /From docs\/architecture\.md:\*\*\n  ## Payments/);
  assert.ok(!c.includes('Project map'), 'chat models already get the full map elsewhere');
  assert.ok(contextPack(dir, { files: ['src/cart.js'], kind: 'agent', budget: 200 }).length < 260, 'budget respected');
});

let server, port; const seen = [];
before(async () => {
  server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => b += d).on('end', () => {
    seen.push(JSON.parse(b));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: '<<<FILE src/cart.js\nexport function total(lines) { return lines.reduce((t, l) => t + l.price, 0); }\nexport const EMPTY = [];\nexport const size = (lines) => lines.length;\nFILE>>>\n## RESULT: DONE\n## Acceptance\n- [x] 1. ok — evidence: src/cart.js:3\n' } }] }));
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port;
});
after(() => server.close());

const PLAN = '# Plan\n## Open questions\n- [x] none\n## Tasks\n### T1: size\n- **role:** build\n- **files:** `src/cart.js`\n- **acceptance:**\n  - [ ] `size([1, 2])` returns 2\n';
test('both kinds of worker get the pack in their prompt, plus their own promptExtra', async () => {
  clearCooldowns(); seen.length = 0;
  fakeBins({ 'cx-agent': "let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.writeFileSync(process.env.CX_PROMPT,p);fs.appendFileSync('src/cart.js','export const size = (l) => l.length;\\n');fs.writeFileSync(o,'## RESULT: DONE\\n## Acceptance\\n- [x] 1. ok — evidence: src/cart.js:3\\n');});" });
  const mk = () => { const files = { ...FILES, 'docs/plan/p.md': PLAN }; delete files['.env']; return makeRepo({ files }).dir; };
  let dir = mk();
  process.env.CX_PROMPT = path.join(dir, '.git', 'CX_PROMPT.txt');
  let cfg = loadConfig(dir);
  cfg.providers.ag = { type: 'cli', preset: 'codex', enabled: true, bin: 'cx-agent', promptExtra: 'Keep functions under 20 lines.' };
  let s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['ag'], noReview: true });
  assert.equal(s.winner, 'ag');
  const ap = fs.readFileSync(process.env.CX_PROMPT, 'utf8');
  assert.match(ap, /## Context \(gathered by conductor[\s\S]*Verify\*\* \(must pass before DONE\): `npm run test`[\s\S]*`src\/checkout\.js`: total:1,2/);
  assert.match(ap, /## Note for this model\nKeep functions under 20 lines\.\n[\s\S]*## Before you finish/, 'the extra comes before the recited criteria, which stay last');
  dir = mk();
  cfg = loadConfig(dir);
  cfg.providers.ch = { type: 'openai', location: 'cloud-api', enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: '', model: 'm', promptExtra: 'Answer with the files first.' };
  s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['ch'], noReview: true });
  assert.equal(s.winner, 'ch');
  const user = seen[0].messages[1].content;
  assert.match(user, /Used elsewhere\*\* \(keep these working\):\n  - `src\/checkout\.js:2`: `export function pay/);
  assert.match(user, /## Note for this model\nAnswer with the files first\./);
});
