// Verify detection for Node, PHP and Python projects (found missing for Python by the UX checklist: pytest was only
// detected when it was on the global PATH, so a project with a venv or `python -m pytest` got no Verify command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.js';

const { detectVerify } = await import('../src/verify.js');
const project = (files) => {
  const dir = tmpdir('conductor-verify-');
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
};

test('Node and PHP: the project scripts', () => {
  assert.equal(detectVerify(project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }) })), 'npm run lint && npm run test');
  assert.equal(detectVerify(project({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'pnpm-lock.yaml': '' })), 'pnpm run test');
  assert.equal(detectVerify(project({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) })), 'composer test');
  assert.equal(detectVerify(project({ 'composer.json': '{}', 'phpunit.xml': '' })), 'vendor/bin/phpunit');
});

test('Python: a project venv first, then python -m pytest when pytest is configured; nothing when there is nothing to run', () => {
  const PATH = process.env.PATH;
  process.env.PATH = '/nonexistent'; // no global pytest or ruff
  try {
    assert.equal(detectVerify(project({ 'pyproject.toml': '[project]\nname = "p"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' })), 'python3 -m pytest -q');
    assert.equal(detectVerify(project({ 'requirements.txt': '', 'tests/test_a.py': '' })), 'python3 -m pytest -q', 'a tests folder with test files');
    assert.equal(detectVerify(project({ 'setup.cfg': '[tool:pytest]\n' })), 'python3 -m pytest -q');
    assert.equal(detectVerify(project({ 'requirements.txt': '', '.venv/bin/python': '', '.venv/bin/pytest': '', '.venv/bin/ruff': '', 'ruff.toml': '' })), '.venv/bin/ruff check . && .venv/bin/pytest -q');
    assert.equal(detectVerify(project({ 'requirements.txt': '', '.venv/bin/python': '', 'pytest.ini': '[pytest]\n' })), '.venv/bin/python -m pytest -q');
    assert.equal(detectVerify(project({ 'requirements.txt': '' })), '', 'nothing to run');
  } finally { process.env.PATH = PATH; }
});
