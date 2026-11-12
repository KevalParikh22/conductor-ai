// Q8: per-controller files from one source, and doctor checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, tmpdir, fakeBins } from './helpers.js';

isolateHome();
const C = await import('../src/controllers.js');
const { initProject } = await import('../src/init.js');
const { readBlock } = await import('../src/localfiles.js');
const { dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const rules = (dir) => {
  fs.mkdirSync(path.join(dir, '.conductor/rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.conductor/rules/api-errors.md'), '---\ndescription: How API handlers report errors\npaths: src/api/**, *.ts\n---\n\n- Every handler returns { data, error }.\n');
  fs.writeFileSync(path.join(dir, '.conductor/rules/money.md'), '---\ndescription: Money\n---\n\n- Prices are integer cents.\n');
};
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('one rule source, written the way each controller reads it, plus the reviewer subagent', () => {
  const { dir } = makeRepo(); rules(dir);
  C.syncControllerFiles(dir, 'claude-code');
  assert.equal(read(dir, '.claude/rules/conductor-api-errors.md'), '---\ndescription: "How API handlers report errors"\npaths: ["src/api/**", "*.ts"]\n---\n\n- Every handler returns { data, error }.\n');
  assert.ok(!read(dir, '.claude/rules/conductor-money.md').includes('paths:'), 'no paths: always loaded');
  assert.match(read(dir, '.claude/agents/conductor-reviewer.md'), /^---\nname: conductor-reviewer\ndescription: ".*"\ntools: Read, Grep, Glob, Bash\nmodel: inherit\n---/);
  C.syncControllerFiles(dir, 'antigravity');
  assert.match(read(dir, '.agents/rules/conductor-api-errors.md'), /^---\ntrigger: glob\ndescription: How API handlers report errors\nglobs: src\/api\/\*\*, \*\.ts\n---/);
  assert.match(read(dir, '.agents/rules/conductor-money.md'), /^---\ntrigger: always_on\n/);
  assert.match(read(dir, '.agents/agents/conductor-reviewer.md'), /^---\nname: conductor-reviewer\n/);
  C.syncControllerFiles(dir, 'codex-cli');
  assert.match(read(dir, 'AGENTS.md'), /<!-- conductor:project-rules:start -->\n## Project rules\n### api-errors \(applies to src\/api\/\*\*, \*\.ts\)\n- Every handler returns[\s\S]*### money\n- Prices are integer cents\.\n<!-- conductor:project-rules:end -->/);
  assert.match(read(dir, '.codex/agents/conductor-reviewer.toml'), /^name = "conductor-reviewer"\ndescription = ".*"\ndeveloper_instructions = '''\n/);
  C.syncControllerFiles(dir, 'opencode');
  const oc = read(dir, '.opencode/agents/conductor-reviewer.md');
  assert.match(oc, /mode: subagent\npermissions:\n  - action: edit\n    resource: "\*"\n    effect: deny\n  - action: shell\n    resource: "\*"\n    effect: deny\n  - action: shell\n    resource: "conductor diff\*"\n    effect: allow/, 'catch-all deny first: OpenCode 2 applies the last match');
});

test('sync is idempotent, removes rules you deleted, and only ever touches conductor-* files', () => {
  const { dir } = makeRepo(); rules(dir);
  fs.mkdirSync(path.join(dir, '.claude/rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/rules/mine.md'), 'my own rule\n');
  assert.ok(C.syncControllerFiles(dir, 'claude-code').length > 0);
  assert.deepEqual(C.syncControllerFiles(dir, 'claude-code'), [], 'nothing changes the second time');
  fs.rmSync(path.join(dir, '.conductor/rules/money.md'));
  assert.deepEqual(C.syncControllerFiles(dir, 'claude-code'), [['removed', '.claude/rules/conductor-money.md']]);
  assert.ok(fs.existsSync(path.join(dir, '.claude/rules/mine.md')), 'your own rule file is never touched');
  C.syncControllerFiles(dir, 'codex-cli');
  fs.rmSync(path.join(dir, '.conductor/rules'), { recursive: true });
  C.syncControllerFiles(dir, 'codex-cli');
  assert.ok(!read(dir, 'AGENTS.md').includes('project-rules'), 'block removed with the last rule');
});

test('workers get only the rules that match their files', () => {
  const { dir } = makeRepo(); rules(dir);
  assert.deepEqual(C.rulesForFiles(dir, ['src/api/users.js']).map((r) => r.name), ['api-errors', 'money']);
  assert.deepEqual(C.rulesForFiles(dir, ['lib/x.py']).map((r) => r.name), ['money']);
  assert.match(C.rulesPrompt(dir, ['src/util.ts']), /^\n## Project rules for these files\n### api-errors \(applies to src\/api\/\*\*, \*\.ts\)/);
});

test('doctor finds what controllers silently ignore', () => {
  const { dir } = makeRepo();
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w('.agents/rules/a.md', '---\ntrigger: alwaysOn\n---\nx');
  w('.agents/rules/b.md', '---\ntrigger: glob\n---\nx');
  w('.agents/rules/c.md', 'no frontmatter');
  w('.agents/rules/ok.md', '---\ntrigger: always_on\n---\nx');
  w('.agents/skills/s/SKILL.md', '---\nname: s\n---\nbody');
  w('.mcp.json', '{ "mcpServers": ');
  w('.codex/agents/x.toml', 'name = "x"');
  const home = tmpdir('codex-home-'); process.env.CODEX_HOME = home;
  let issues = C.checkControllerFiles(dir, 'codex-cli');
  const by = (f) => issues.filter((i) => i.file === f).map((i) => i.problem).join(' | ');
  assert.match(by('.agents/rules/a.md'), /trigger "alwaysOn" is not one Antigravity knows/);
  assert.match(by('.agents/rules/b.md'), /glob without globs/);
  assert.match(by('.agents/rules/c.md'), /no frontmatter/);
  assert.equal(by('.agents/rules/ok.md'), '');
  assert.match(by('.agents/skills/s/SKILL.md'), /no description/);
  assert.match(by('.mcp.json'), /not valid JSON/);
  assert.match(by('.codex/'), /ignores this project's \.codex\/ folder/);
  fs.writeFileSync(path.join(home, 'config.toml'), `[projects."${fs.realpathSync(dir)}"]\ntrust_level = "trusted"\n`);
  issues = C.checkControllerFiles(dir, 'codex-cli');
  assert.equal(by('.codex/'), '', 'a trusted project is fine');
  delete process.env.CODEX_HOME;
});

test('init writes them for its controller and keeps them out of git; the CLI creates, lists and syncs', () => {
  const { dir } = makeRepo(); rules(dir);
  const r = initProject(dir, { controller: 'antigravity' });
  assert.ok(r.lines.some((l) => /added +\.agents\/rules\/conductor-api-errors\.md/.test(l)));
  assert.ok(fs.existsSync(path.join(dir, '.agents/agents/conductor-reviewer.md')));
  for (const e of ['.agents/rules/conductor-*', '.agents/agents/conductor-*', '.claude/agents/conductor-*']) assert.ok(readBlock(dir).includes(e), e);
  const bin = path.resolve('bin/conductor.js');
  const cli = (...a) => execFileSync('node', [bin, 'rules', ...a], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.match(cli('new', 'naming', '--paths', 'src/**', '--description', 'Naming'), /created \.conductor\/rules\/naming\.md/);
  assert.match(cli('list'), /naming +src\/\*\* +Naming/);
  assert.match(cli('sync'), /added +\.agents\/rules\/conductor-naming\.md/);
});

test('a worker\'s prompt carries the rules for its files, not the others', async () => {
  clearCooldowns();
  const PLAN = '# Plan\n## Open questions\n- [x] none\n## Tasks\n### T1: x\n- **role:** build\n- **files:** `lib/a.py`\n- **acceptance:**\n  - [ ] lib/a.py exposes area(r) for circles\n- **verify:** `true`\n';
  const { dir, git } = makeRepo({ files: { 'docs/plan/p.md': PLAN } }); rules(dir);
  git('add', '-A'); git('commit', '-qm', 'rules');
  fakeBins({ 'ct-worker': "let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.writeFileSync(process.env.CT_PROMPT,p);fs.mkdirSync('lib',{recursive:true});fs.writeFileSync('lib/a.py','x=1\\n');fs.writeFileSync(o,'## RESULT: DONE\\n## Acceptance\\n- [x] 1. ok — evidence: lib/a.py:1\\n');});" });
  process.env.CT_PROMPT = path.join(dir, '.git', 'CT_PROMPT.txt');
  const cfg = loadConfig(dir);
  cfg.providers.w = { type: 'cli', preset: 'codex', enabled: true, bin: 'ct-worker' };
  await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['w'] });
  const prompt = fs.readFileSync(process.env.CT_PROMPT, 'utf8');
  assert.match(prompt, /## Project rules for these files\n### money\n- Prices are integer cents\./);
  assert.ok(!prompt.includes('api-errors'), 'a rule for other paths is left out');
});
