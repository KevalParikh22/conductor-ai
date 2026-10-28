import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, tmpdir, PLAN } from './helpers.js';

isolateHome();
const { extractTask, extractSection, taskFiles, parseFileBlocks, applyFileBlocks, isProtected } = await import('../src/core.js');
const { deepDiff } = await import('../src/ui/server.js');
const { deepMerge } = await import('../src/util.js');
const { validateConfig, providerLocation, providerReadiness } = await import('../src/config.js');
const { DEFAULT_CONFIG } = await import('../src/presets.js');

test('extractTask returns only the requested task section', () => {
  const t1 = extractTask(PLAN, 'T1');
  assert.match(t1, /^### T1: add function/);
  assert.doesNotMatch(t1, /T2/);
  assert.match(extractTask(PLAN, 'T2'), /README/);
  assert.equal(extractTask(PLAN, 'T9'), '');
  assert.equal(extractTask('### T10: x\n', 'T1'), '', 'T1 must not match T10');
});

test('extractSection and taskFiles', () => {
  assert.equal(extractSection(PLAN, 'Design notes'), '- add() lives in src/add.js');
  assert.deepEqual(taskFiles(extractTask(PLAN, 'T1')), ['src/add.js']);
});

test('parseFileBlocks handles plain and fenced content', () => {
  const text = 'intro\n<<<FILE src/a.js\nexport const a = 1;\nFILE>>>\n<<<FILE b.md\n```md\n# B\n```\nFILE>>>\n## RESULT: DONE';
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { path: 'src/a.js', content: 'export const a = 1;\n' });
  assert.equal(blocks[1].content, '# B\n');
});

test('applyFileBlocks refuses paths outside the repo and protected files', () => {
  const root = tmpdir();
  const { applied, rejected } = applyFileBlocks(root, [
    { path: 'src/ok.js', content: 'ok' },
    { path: '../escape.js', content: 'x' },
    { path: '/etc/passwd', content: 'x' },
    { path: 'AGENTS.md', content: 'x' },
    { path: '.git/config', content: 'x' },
    { path: 'docs/plan/p.md', content: 'x' },
    { path: '.env', content: 'x' },
  ]);
  assert.deepEqual(applied, ['src/ok.js']);
  assert.equal(rejected.length, 6);
  assert.equal(fs.readFileSync(path.join(root, 'src/ok.js'), 'utf8'), 'ok');
  assert.ok(!fs.existsSync(path.join(root, '..', 'escape.js')));
});

test('isProtected', () => {
  assert.ok(isProtected('CLAUDE.md'));
  assert.ok(isProtected('.claude/commands/x.md'));
  assert.ok(isProtected('web/.env.local'));
  assert.ok(isProtected('auth.json'));
  assert.ok(isProtected('.agents/skills/x/SKILL.md'));
  assert.ok(isProtected('app/etc/env.php', ['^app/etc/env\\.php$']));
  assert.ok(!isProtected('app/etc/env.php'));
  assert.ok(!isProtected('src/claude.js'));
});

test('deepDiff stores only overrides', () => {
  const eff = deepMerge(DEFAULT_CONFIG, { roles: { build: ['codex-cli'] }, providers: { opencode: { model: 'x' } } });
  assert.deepEqual(deepDiff(DEFAULT_CONFIG, eff), { roles: { build: ['codex-cli'] }, providers: { opencode: { model: 'x' } } });
});

test('validateConfig catches unknown providers and types', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  const bad = deepMerge(DEFAULT_CONFIG, { roles: { build: ['nope'] }, providers: { x: { type: 'weird' } } });
  const errs = validateConfig(bad);
  assert.ok(errs.some((e) => e.includes('nope')));
  assert.ok(errs.some((e) => e.includes('weird')));
});

test('providerLocation', () => {
  assert.equal(providerLocation({ type: 'cli' }), 'local-agent');
  assert.equal(providerLocation({ type: 'openai', baseUrl: 'http://localhost:11434/v1' }), 'local-model');
  assert.equal(providerLocation({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }), 'cloud-api');
});

test('default chains use Antigravity and keyless Kilo; Gemini CLI is kept but off', () => {
  const P = DEFAULT_CONFIG.providers;
  assert.equal(P['gemini-cli'].enabled, false);
  assert.equal(P['antigravity-cli'].preset, 'antigravity');
  assert.ok(!Object.values(DEFAULT_CONFIG.roles).flat().includes('gemini-cli'));
  assert.ok(DEFAULT_CONFIG.roles.test.includes('kilo-free'));
  delete process.env.KILO_API_KEY;
  assert.deepEqual(providerReadiness('kilo-free', P['kilo-free']), { ready: true, reason: 'no key needed' });
});
