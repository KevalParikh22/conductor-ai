// Windows: npm installs CLIs as .cmd shims, which Node can't start directly. conductor runs the shim's script with
// node instead, so prompt text in the arguments never passes through cmd.exe. Checked on every OS (pure logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.js';

const { winCommand } = await import('../src/util.js');

const NPM_SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;

test('an npm .cmd shim runs its script with node, the arguments untouched (no cmd.exe)', () => {
  const dir = tmpdir('conductor-win-');
  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, NPM_SHIM);
  const prompt = 'line 1\nrm -rf / & echo "x" | more %PATH% ^';
  const w = winCommand(shim, ['exec', prompt]);
  assert.equal(w.file, process.execPath);
  assert.deepEqual(w.args, [path.join(dir, 'node_modules\\@openai\\codex\\bin\\codex.js'), 'exec', prompt]);
  assert.deepEqual(w.opts, {});
});

test('a short shim (@node "%~dp0\\x" %*) is read the same way', () => {
  const dir = tmpdir('conductor-win-');
  const shim = path.join(dir, 'fake.cmd');
  fs.writeFileSync(shim, '@node "%~dp0\\fake" %*\r\n');
  assert.deepEqual(winCommand(shim, ['-p', 'hi']).args, [path.join(dir, 'fake'), '-p', 'hi']);
});

test('another .bat goes through cmd.exe with every metacharacter escaped; an .exe runs as is', () => {
  const dir = tmpdir('conductor-win-');
  const bat = path.join(dir, 'tool.bat');
  fs.writeFileSync(bat, '@echo off\r\nsomething.exe %*\r\n');
  const w = winCommand(bat, ['a & b', 'say "hi"']);
  assert.deepEqual(w.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(w.opts.windowsVerbatimArguments, true);
  assert.ok(w.args[3].includes('^"a^ ^&^ b^"'), w.args[3]);
  assert.ok(!/[^^]&/.test(w.args[3]), 'no unescaped &');
  const exe = path.join(dir, 'agy.exe');
  fs.writeFileSync(exe, '');
  assert.deepEqual(winCommand(exe, ['-p', 'x']), { file: exe, args: ['-p', 'x'], opts: {} });
});

test('a plan saved with Windows line endings (CRLF) reads the same as one with LF', async () => {
  const { extractTask, extractSection, openQuestions } = await import('../src/plan.js');
  const { checkPlan } = await import('../src/plancheck.js');
  const lf = '# Plan\n\n## Open questions\n- [ ] which db?\n\n## Tasks\n\n### T1: add\n- **role:** build\n- **files:** `src/add.js`\n- **verify:** `npm test`\n- **acceptance:**\n  - [ ] `add(2, 3)` returns `5`\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(extractTask(crlf, 'T1'), extractTask(lf, 'T1'));
  assert.equal(extractSection(crlf, 'Open questions'), extractSection(lf, 'Open questions'));
  assert.deepEqual(openQuestions(crlf), ['which db?']);
  assert.deepEqual(checkPlan(crlf, { verifyCmd: 'npm test' }), checkPlan(lf, { verifyCmd: 'npm test' }));
});
