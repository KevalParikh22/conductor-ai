// Q8: give each controller only what it really reads, in its own format, from one source.
//   rules     .conductor/rules/<name>.md (description, optional paths) →
//               Claude Code  .claude/rules/conductor-<name>.md   (paths: [...])
//               Antigravity  .agents/rules/conductor-<name>.md   (trigger: glob + globs, or always_on; agy silently
//                            drops a rule whose frontmatter is wrong, so conductor writes it for you)
//               Codex/OpenCode  a block in AGENTS.md (they have no path-scoped rule files)
//             Workers get the rules matching their files in the prompt.
//   reviewer  a conductor-reviewer subagent that reviews a worker's diff in a fresh context, so the controller
//             doesn't spend its own context on it.
// Only files conductor made (named conductor-*) are ever replaced or removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_DIRNAME } from './config.js';
import { globToRegex } from './routing.js';

export const rulesDir = (root) => path.join(root, PROJECT_DIRNAME, 'rules');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RULES_START = '<!-- conductor:project-rules:start -->', RULES_END = '<!-- conductor:project-rules:end -->';

/** Frontmatter (flat key: value, or a YAML/JSON-style list for paths) and body. */
function parseFront(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^([\w-]+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim(); }
  return { meta, body: (m ? m[2] : String(text)).trim() };
}
const list = (v) => String(v || '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

export function readRules(root) {
  let names = [];
  try { names = fs.readdirSync(rulesDir(root)).filter((n) => n.endsWith('.md')).sort(); } catch { return []; }
  return names.map((n) => {
    const { meta, body } = parseFront(fs.readFileSync(path.join(rulesDir(root), n), 'utf8'));
    return { name: n.replace(/\.md$/, ''), description: meta.description || '', paths: list(meta.paths), body };
  }).filter((r) => NAME_RE.test(r.name) && r.body);
}

export function newRule(root, name, { description = '', paths = '' } = {}) {
  if (!NAME_RE.test(name)) throw new Error('rule names are lowercase letters, digits and dashes (e.g. api-errors)');
  const file = path.join(rulesDir(root), `${name}.md`);
  if (fs.existsSync(file)) throw new Error(`rule "${name}" already exists (${file})`);
  fs.mkdirSync(rulesDir(root), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${description || `What ${name} covers`}\n${paths ? `paths: ${paths}\n` : ''}---\n\n- Write the rule as short, checkable statements.\n`);
  return file;
}

/** Rules that apply to these files (a rule without paths applies to everything). */
export function rulesForFiles(root, files = []) {
  return readRules(root).filter((r) => !r.paths.length || files.some((f) => r.paths.some((p) => globToRegex(p).test(f.replace(/^\.\//, '')))));
}

/** The worker-prompt section for the matching rules. */
export function rulesPrompt(root, files) {
  const hits = rulesForFiles(root, files);
  if (!hits.length) return '';
  return `\n## Project rules for these files\n${hits.map((r) => `### ${r.name}${r.paths.length ? ` (applies to ${r.paths.join(', ')})` : ''}\n${r.body}`).join('\n\n')}\n`;
}

const REVIEWER_BODY = `You review work that a conductor worker did, in a fresh context, so the controller doesn't spend its own context on it. You never edit files and never commit.

1. Read the task the worker had (docs/plan/<plan>.md, the task id you were given) and its acceptance criteria.
2. Get the change: \`conductor diff\` for the working tree, or \`conductor diff conductor/<id>\` for a worktree task.
3. Check, against the task: does it do what the acceptance criteria say; bugs and edge cases; missing error handling; security; changes outside the task's files; tests that really prove the behaviour.
4. Report only real problems, each with \`path:line\`, a concrete failure scenario and a one-line fix. End with \`VERDICT: APPROVE\` or \`VERDICT: CHANGES_REQUESTED\`.`;
const REVIEWER_DESC = "Reviews a conductor worker's diff against its plan task in a fresh context and returns findings with path:line and a verdict. Use after a conductor run, before committing.";

function writeIfChanged(file, text, log, label) {
  let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (cur === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  log(cur === null ? 'added' : 'updated', label);
}

function removeStale(dir, keep, log, rel) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) if (n.startsWith('conductor-') && !keep.includes(n)) { fs.rmSync(path.join(dir, n), { force: true }); log('removed', `${rel}/${n}`); }
}

function mergeBlock(file, block, log, label) {
  let cur = ''; try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  const i = cur.indexOf(RULES_START), j = cur.indexOf(RULES_END);
  const rest = i >= 0 && j > i ? cur.slice(0, i).trimEnd() + cur.slice(j + RULES_END.length) : cur;
  const next = block ? `${rest.trimEnd()}${rest.trim() ? '\n\n' : ''}${RULES_START}\n${block}\n${RULES_END}\n` : `${rest.trimEnd()}\n`;
  if (next === cur || (!block && i < 0)) return;
  fs.writeFileSync(file, next);
  log(block ? 'merged' : 'removed', label);
}

/**
 * Write the rules and the reviewer subagent in the format `controller` reads. → [[what, path]] for the init log.
 */
export function syncControllerFiles(root, controller) {
  const out = [];
  const log = (what, p) => out.push([what, p]);
  const rules = readRules(root);
  const yamlList = (a) => `[${a.map((x) => JSON.stringify(x)).join(', ')}]`;
  if (controller === 'claude-code') {
    for (const r of rules) writeIfChanged(path.join(root, '.claude/rules', `conductor-${r.name}.md`), `---\ndescription: ${JSON.stringify(r.description || r.name)}\n${r.paths.length ? `paths: ${yamlList(r.paths)}\n` : ''}---\n\n${r.body}\n`, log, `.claude/rules/conductor-${r.name}.md`);
    removeStale(path.join(root, '.claude/rules'), rules.map((r) => `conductor-${r.name}.md`), log, '.claude/rules');
    writeIfChanged(path.join(root, '.claude/agents/conductor-reviewer.md'), `---\nname: conductor-reviewer\ndescription: ${JSON.stringify(REVIEWER_DESC)}\ntools: Read, Grep, Glob, Bash\nmodel: inherit\n---\n\n${REVIEWER_BODY}\n`, log, '.claude/agents/conductor-reviewer.md');
  } else if (controller === 'antigravity') {
    // agy: trigger must be always_on | model_decision | glob | manual, and glob needs globs; anything else is dropped silently
    for (const r of rules) writeIfChanged(path.join(root, '.agents/rules', `conductor-${r.name}.md`), `---\ntrigger: ${r.paths.length ? 'glob' : 'always_on'}\ndescription: ${r.description || r.name}\n${r.paths.length ? `globs: ${r.paths.join(', ')}\n` : ''}---\n\n${r.body}\n`, log, `.agents/rules/conductor-${r.name}.md`);
    removeStale(path.join(root, '.agents/rules'), rules.map((r) => `conductor-${r.name}.md`), log, '.agents/rules');
    writeIfChanged(path.join(root, '.agents/agents/conductor-reviewer.md'), `---\nname: conductor-reviewer\ndescription: ${REVIEWER_DESC}\nmodel: inherit\n---\n\n${REVIEWER_BODY}\n`, log, '.agents/agents/conductor-reviewer.md');
  } else if (controller === 'codex-cli' || controller === 'opencode') {
    const block = rules.length ? `## Project rules\n${rules.map((r) => `### ${r.name}${r.paths.length ? ` (applies to ${r.paths.join(', ')})` : ''}\n${r.body}`).join('\n\n')}` : '';
    mergeBlock(path.join(root, 'AGENTS.md'), block, log, 'AGENTS.md (project rules)');
    if (controller === 'codex-cli') {
      writeIfChanged(path.join(root, '.codex/agents/conductor-reviewer.toml'), `name = "conductor-reviewer"\ndescription = ${JSON.stringify(REVIEWER_DESC)}\ndeveloper_instructions = '''\n${REVIEWER_BODY}\n'''\n`, log, '.codex/agents/conductor-reviewer.toml');
    } else {
      // OpenCode 2: ordered permissions, last match wins, so the catch-all deny comes first
      const perms = [['edit', '*', 'deny'], ['shell', '*', 'deny'], ['shell', 'conductor diff*', 'allow'], ['shell', 'git diff*', 'allow'], ['shell', 'git log*', 'allow'], ['shell', 'git show*', 'allow']];
      writeIfChanged(path.join(root, '.opencode/agents/conductor-reviewer.md'), `---\ndescription: ${JSON.stringify(REVIEWER_DESC)}\nmode: subagent\npermissions:\n${perms.map(([a, r, e]) => `  - action: ${a}\n    resource: ${JSON.stringify(r)}\n    effect: ${e}`).join('\n')}\n---\n\n${REVIEWER_BODY}\n`, log, '.opencode/agents/conductor-reviewer.md');
    }
  }
  return out;
}

// ---------------- doctor ----------------
const AGY_TRIGGERS = new Set(['always_on', 'model_decision', 'glob', 'manual']);

/** Problems in the files controllers read. → [{ level: 'error' | 'warn', file, problem, fix }] */
export function checkControllerFiles(root, controller) {
  const out = [];
  const add = (level, file, problem, fix) => out.push({ level, file, problem, fix });
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  const ls = (rel) => { try { return fs.readdirSync(path.join(root, rel)); } catch { return []; } };
  // Antigravity drops rules with bad frontmatter without a word
  for (const n of ls('.agents/rules').filter((x) => x.endsWith('.md'))) {
    const rel = `.agents/rules/${n}`, text = read(rel);
    const { meta } = parseFront(text);
    if (!/^---\r?\n/.test(text)) add('error', rel, 'no frontmatter, so Antigravity ignores this rule', 'start it with ---\\ntrigger: always_on\\n---');
    else if (!AGY_TRIGGERS.has(meta.trigger)) add('error', rel, `trigger "${meta.trigger || ''}" is not one Antigravity knows, so it ignores this rule`, 'use trigger: always_on, model_decision, glob or manual (lowercase, with underscores)');
    else if (meta.trigger === 'glob' && !meta.globs) add('error', rel, 'trigger: glob without globs, so it never applies', 'add globs: src/**/*.ts');
    else if (meta.trigger === 'model_decision' && !meta.description) add('error', rel, 'trigger: model_decision needs a description', 'add description: when to use it');
    if (Buffer.byteLength(text) > 24_000) add('warn', rel, `${Buffer.byteLength(text)} bytes: Antigravity reads at most 24,000 per rule file`, 'split it');
  }
  for (const n of ls('.claude/rules').filter((x) => x.endsWith('.md'))) {
    const rel = `.claude/rules/${n}`, { meta } = parseFront(read(rel));
    if (meta.paths && !/^\[.*\]$/.test(meta.paths) && !/^["']?[^\s]+/.test(meta.paths)) add('warn', rel, 'paths should be a list, e.g. ["src/api/**/*.ts"]', 'fix the paths line');
  }
  for (const t of ['.claude/skills', '.agents/skills']) {
    for (const n of ls(t)) {
      const rel = `${t}/${n}/SKILL.md`, text = read(rel);
      if (text === null) continue;
      const { meta } = parseFront(text);
      if (!meta.name && !/^---/.test(text)) add('error', rel, 'no frontmatter: controllers can\'t list this skill', 'add --- name / description ---');
      else if (!meta.description) add('error', rel, 'no description: it is the trigger, so the skill is never picked', 'add description: what it does and when to use it');
    }
  }
  const agents = read('AGENTS.md');
  if (agents !== null && controller === 'codex-cli' && Buffer.byteLength(agents) > 32 * 1024) add('warn', 'AGENTS.md', `${Buffer.byteLength(agents)} bytes: Codex reads at most 32 KiB of AGENTS.md in total`, 'move topics into .conductor/rules or skills');
  if (agents !== null && controller === 'antigravity' && Buffer.byteLength(agents) > 24_000) add('warn', 'AGENTS.md', `${Buffer.byteLength(agents)} bytes: Antigravity reads at most 24,000 per file`, 'move topics into .conductor/rules or skills');
  for (const rel of ['.mcp.json', 'opencode.json', '.agents/mcp_config.json', '.vscode/mcp.json']) {
    const text = read(rel);
    if (text === null) continue;
    try { JSON.parse(text); } catch (e) { add('error', rel, `not valid JSON (${e.message.split('\n')[0]}): the controller ignores it`, 'fix the JSON'); }
  }
  // Codex ignores a project's .codex/ folder (agents, hooks, rules, MCP) until the project is trusted
  if (fs.existsSync(path.join(root, '.codex'))) {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    let cfg = ''; try { cfg = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* none */ }
    const real = fs.realpathSync(root);
    const trusted = [root, real].some((r) => new RegExp(`\\[projects\\.(?:"${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"|'${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}')\\][^\\[]*trust_level\\s*=\\s*"trusted"`).test(cfg));
    if (!trusted) add('warn', '.codex/', "Codex ignores this project's .codex/ folder (the reviewer agent, hooks) until you trust the project", 'open codex in the project once and choose to trust it');
  }
  return out;
}
