// The routing engine: role -> provider chain -> attempt with fallback -> verify -> summary.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES } from './presets.js';
import { providerReadiness, providerKind, PROJECT_DIRNAME } from './config.js';
import { runProvider } from './providers.js';
import * as git from './git.js';
import { runVerify } from './verify.js';
import { GLOBAL_DIR, readJSON, writeJSON, timestamp, rel } from './util.js';

const PROMPTS = new URL('./prompts/', import.meta.url);
const loadPrompt = (n) => fs.readFileSync(new URL(`${n}.md`, PROMPTS), 'utf8');

export class UsageError extends Error {}

// Files workers must never touch (agents are told; chat output is filtered).
const PROTECTED = [/^AGENTS\.md$/, /^CLAUDE\.md$/, /^GEMINI\.md$/, /^HANDOFF\.md$/, /^docs\/plan\//, /^\.claude\//, /^\.gemini\//, /^\.agents\//,
  /^\.conductor\//, /^\.git\//, /^\.mcp\.json$/, /(^|\/)node_modules\//, /(^|\/)\.env(\.|$)/, /(^|\/)auth\.json$/];
/** `extra`: regex strings from settings.protectedPaths (e.g. "^app/etc/env\\.php$"). */
export const isProtected = (p, extra = []) => {
  const norm = p.replaceAll('\\', '/');
  return PROTECTED.some((re) => re.test(norm)) || extra.some((src) => new RegExp(src).test(norm));
};

// ---------------- cooldowns (shared across projects) ----------------
const STATE = () => path.join(GLOBAL_DIR, 'state.json');

export function getCooldowns() {
  const s = readJSON(STATE(), {});
  const now = Date.now(), out = {};
  for (const [n, c] of Object.entries(s.cooldowns || {})) if (c.until > now) out[n] = c;
  return out;
}
export function setCooldown(name, minutes, reason) {
  const s = readJSON(STATE(), {});
  s.cooldowns = { ...getCooldowns(), [name]: { until: Date.now() + minutes * 60_000, reason } };
  writeJSON(STATE(), s);
}
export function clearCooldowns(name) {
  const s = readJSON(STATE(), {});
  if (name) delete (s.cooldowns ||= {})[name]; else s.cooldowns = {};
  writeJSON(STATE(), s);
}

// ---------------- plan parsing ----------------
export function extractTask(planText, taskId) {
  const lines = planText.split('\n');
  const head = new RegExp(`^(#{2,4})\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

export function extractSection(planText, title) {
  const m = planText.match(new RegExp(`^##\\s+${title}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'));
  return m ? m[1].trim() : '';
}

/** Paths in backticks on a "files:" line of a task. */
export function taskFiles(section) {
  const line = section.split('\n').find((l) => /\bfiles\b\**\s*:/i.test(l)) || '';
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((p) => !p.includes(' '));
}

// ---------------- chat-model file blocks ----------------
export function parseFileBlocks(text) {
  const blocks = [];
  const re = /^<<<FILE[ \t]+(\S+)[ \t]*\r?\n([\s\S]*?)^FILE>>>[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    let content = m[2];
    // tolerate models that wrap the content in a code fence
    const fenced = content.match(/^```[\w.+-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced) content = fenced[1] + '\n';
    blocks.push({ path: m[1], content });
  }
  return blocks;
}

export function applyFileBlocks(root, blocks, extraProtected = []) {
  const applied = [], rejected = [];
  for (const b of blocks) {
    const norm = path.normalize(b.path).replaceAll('\\', '/');
    const abs = path.resolve(root, norm);
    if (path.isAbsolute(b.path) || norm.startsWith('..') || !abs.startsWith(path.resolve(root) + path.sep)) { rejected.push(`${b.path} (outside repo)`); continue; }
    if (isProtected(norm, extraProtected)) { rejected.push(`${b.path} (protected)`); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, b.content);
    applied.push(norm);
  }
  return { applied, rejected };
}

// ---------------- chain resolution ----------------
export function resolveChain(cfg, role, { provider, chain } = {}) {
  let names = chain?.length ? chain : (cfg.roles[role] || []);
  if (provider) names = [provider, ...names.filter((n) => n !== provider)];
  const cooldowns = getCooldowns();
  return names.map((name) => {
    const p = cfg.providers[name];
    if (!p) return { name, skip: 'unknown provider' };
    const r = providerReadiness(name, p);
    if (!r.ready) return { name, p, skip: r.reason };
    const c = cooldowns[name];
    if (c) return { name, p, skip: `cooling down until ${new Date(c.until).toLocaleTimeString()} (${c.reason})` };
    return { name, p };
  });
}

function readContextFiles(root, files, budget) {
  let out = '', used = 0;
  for (const f of [...new Set(files)]) {
    const abs = path.resolve(root, f);
    if (!abs.startsWith(path.resolve(root))) continue;
    let body;
    try { body = fs.readFileSync(abs, 'utf8'); } catch { out += `\n### ${f}\n(does not exist yet: new file)\n`; continue; }
    if (used + body.length > budget) { out += `\n### ${f}\n(omitted: context budget reached)\n`; continue; }
    used += body.length;
    out += `\n### ${f}\n\`\`\`\n${body}\n\`\`\`\n`;
  }
  return out;
}

// ---------------- dispatch ----------------
/**
 * Run a role with fallback.
 * opts: role, task, planPath, taskId, provider, chain, note, files, base, focus, save, noVerify, allowDirty, onEvent
 */
export async function dispatch(cfg, opts) {
  const { root, settings } = cfg;
  const role = opts.role;
  const meta = ROLES[role];
  if (!meta) throw new UsageError(`unknown role "${role}". Roles: ${Object.keys(ROLES).join(', ')}`);
  const mode = meta.mode;
  const emit = opts.onEvent || (() => {});
  const inRepo = git.isRepo(root);

  // ---- safety
  if (mode === 'write') {
    if (!inRepo) throw new UsageError('write roles need a git repo, so failed attempts can be stashed and diffs reviewed (run: git init && git commit --allow-empty -m init)');
    if (!git.hasCommits(root)) throw new UsageError('the repo has no commits yet: make an initial commit first');
    const b = git.branch(root);
    if ((settings.protectedBranches || []).includes(b)) throw new UsageError(`on protected branch "${b}". Create a branch first: git switch -c feat/<name>`);
    if (settings.requireCleanTree && git.isDirty(root) && !opts.allowDirty) {
      throw new UsageError('working tree is dirty. Commit or stash first (or pass --allow-dirty, which turns off stash-on-failure)');
    }
  }

  // ---- task body
  let body = '', planText = '', section = '';
  if (opts.planPath) {
    const planAbs = path.resolve(root, opts.planPath);
    if (!fs.existsSync(planAbs)) throw new UsageError(`plan not found: ${opts.planPath}`);
    planText = fs.readFileSync(planAbs, 'utf8');
  }
  if (role === 'review') {
    if (!inRepo) throw new UsageError('review needs a git repo');
    const base = opts.base || git.defaultBase(root);
    let diff = git.diffAgainst(root, base);
    if (!diff.trim()) throw new UsageError(`nothing to review: no changes vs ${base}`);
    const max = settings.maxDiffBytes || 100000;
    if (diff.length > max) diff = diff.slice(0, max) + `\n... [diff truncated at ${max} bytes: open the changed files directly for the rest]\n`;
    body = (opts.planPath ? `Plan file: ${opts.planPath}\n` : '') + (opts.focus ? `Extra focus: ${opts.focus}\n` : '') +
      (opts.task ? `Context from the orchestrator: ${opts.task}\n` : '') + `\n# DIFF (vs ${base})\n\`\`\`diff\n${diff}\n\`\`\`\n`;
  } else if (opts.taskId) {
    if (!planText) throw new UsageError('--task needs --plan');
    section = extractTask(planText, opts.taskId);
    if (!section) throw new UsageError(`task "${opts.taskId}" not found in ${opts.planPath} (expected a heading like "### ${opts.taskId}: title")`);
    body = `Plan file: ${opts.planPath} (read its Design notes)\nYour task id: ${opts.taskId}\n\n${section}\n`;
    if (opts.task) body += `\nAdditional instructions: ${opts.task}\n`;
  } else if (opts.task) {
    body = opts.task + '\n' + (opts.planPath ? `\nRelated plan file: ${opts.planPath}\n` : '');
  } else {
    throw new UsageError(role === 'ask' ? 'ask needs a question' : `${role} needs a task: --plan <file> --task <id>, or a task description`);
  }
  if (opts.note) body += `\n## Orchestrator note (important)\n${opts.note}\n`;

  const agentPrompt = `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}\n---\n# TASK (role: ${role})\n${body}`;
  const chatSystem = `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}${mode === 'write' ? '\n' + loadPrompt('_chat_write') : ''}`;
  const chatContext = () => {
    let ctx = '';
    const agents = path.join(root, 'AGENTS.md');
    if (fs.existsSync(agents)) ctx += `# AGENTS.md (project rules, authoritative)\n${fs.readFileSync(agents, 'utf8').slice(0, 20000)}\n`;
    const notes = planText && extractSection(planText, 'Design notes');
    if (notes) ctx += `\n# Design notes from ${opts.planPath}\n${notes}\n`;
    const files = [...(opts.files || []), ...taskFiles(section)];
    if (files.length) ctx += `\n# Relevant files (current content)\n${readContextFiles(root, files, settings.maxContextBytes || 60000)}`;
    return ctx;
  };

  // ---- run dir
  const runsDir = path.join(root, PROJECT_DIRNAME, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  if (!fs.existsSync(path.join(runsDir, '.gitignore'))) fs.writeFileSync(path.join(runsDir, '.gitignore'), '*\n');
  const runDir = path.join(runsDir, `${timestamp()}-${role}${opts.taskId ? '-' + opts.taskId.replace(/[^\w.-]/g, '') : ''}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'task.md'), body);

  const summary = {
    role, mode, task: opts.taskId || null, plan: opts.planPath || null, attempts: [], winner: null, model: null,
    report: null, status: null, changed: [], applied: [], rejected: [], warnings: [], verify: null, runDir: rel(root, runDir), exitCode: 3,
  };
  const quotaRe = new RegExp(settings.quotaPattern, 'i');
  const timeoutMs = (settings.timeoutSec || 1200) * 1000;
  const chain = resolveChain(cfg, role, { provider: opts.provider, chain: opts.chain });
  let winnerText = '';

  for (const c of chain) {
    if (c.skip) { summary.attempts.push({ provider: c.name, ok: false, reason: c.skip, skipped: true }); emit({ type: 'skip', provider: c.name, reason: c.skip }); continue; }
    const kind = providerKind(c.p);
    emit({ type: 'try', provider: c.name, kind });
    const before = inRepo ? git.stateHash(root) : null;
    const t0 = Date.now();
    const userPrompt = kind === 'chat' ? `${chatContext()}\n---\n# TASK (role: ${role})\n${body}` : agentPrompt;
    let res = await runProvider(c.name, c.p, { mode, prompt: userPrompt, system: chatSystem, cwd: root, timeoutMs, runDir, quotaRe });
    fs.writeFileSync(path.join(runDir, `${c.name}.log`), res.log || '');

    if (res.ok && kind === 'chat' && mode === 'write') {
      const blocks = parseFileBlocks(res.text);
      const { applied, rejected } = applyFileBlocks(root, blocks, settings.protectedPaths || []);
      summary.rejected.push(...rejected);
      if (!applied.length) res = { ...res, ok: false, reason: rejected.length ? 'only protected/outside files returned' : 'no file blocks in reply' };
      else summary.applied = applied;
    }
    const attempt = { provider: c.name, kind, ok: res.ok, reason: res.ok ? 'ok' : res.reason, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    const changedDuringRead = mode === 'read' && inRepo && before !== git.stateHash(root);
    if (changedDuringRead) summary.warnings.push(`${c.name} changed files during a read-only run. Check git status.`);

    if (res.ok) {
      summary.attempts.push(attempt);
      summary.winner = c.name; summary.model = res.model || c.p.model || '(default)';
      winnerText = res.text;
      emit({ type: 'ok', provider: c.name });
      break;
    }
    if (res.reason === 'quota') {
      const mins = res.retryAfterSec ? Math.max(1, Math.ceil(res.retryAfterSec / 60)) : (settings.cooldownMinutes || 30);
      setCooldown(c.name, mins, 'rate limited');
      attempt.reason += ` (cooldown ${mins}m)`;
    }
    if (mode === 'write' && !opts.allowDirty && git.isDirty(root)) {
      if (git.stashPush(root, `conductor: failed attempt by ${c.name} ${opts.taskId || role} ${timestamp()}`)) attempt.stashed = true;
    }
    summary.attempts.push(attempt);
    emit({ type: 'fail', provider: c.name, reason: attempt.reason });
  }

  if (!summary.winner) {
    writeJSON(path.join(runDir, 'summary.json'), summary);
    return summary;
  }

  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, winnerText);
  summary.report = rel(root, reportPath);
  summary.status = (winnerText.match(/^#*\s*(RESULT|VERDICT):.*$/m) || [null])[0];
  summary.exitCode = 0;

  if (mode === 'write') {
    summary.changed = git.changedFiles(root);
    const touched = summary.changed.filter((f) => isProtected(f, settings.protectedPaths || []));
    if (touched.length) summary.warnings.push(`worker modified protected files: ${touched.join(', ')}`);
    if (settings.autoVerify !== false && !opts.noVerify) {
      emit({ type: 'verify' });
      summary.verify = await runVerify(root, settings, path.join(runDir, 'verify.log'));
      if (summary.verify.log) summary.verify.log = rel(root, summary.verify.log);
    }
  }
  if (opts.save) {
    const dest = path.resolve(root, opts.save);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, winnerText);
    summary.saved = rel(root, dest);
  }
  writeJSON(path.join(runDir, 'summary.json'), summary);
  return summary;
}

export function formatSummary(s) {
  const L = [];
  L.push('', '==================== CONDUCTOR RESULT ====================');
  L.push(`role:      ${s.role}${s.task ? `   task: ${s.task}` : ''}${s.plan ? `   plan: ${s.plan}` : ''}`);
  L.push(`attempts:  ${s.attempts.map((a) => `${a.provider}(${a.reason}${a.stashed ? ', stashed' : ''})`).join(' → ') || '(none)'}`);
  if (!s.winner) {
    L.push('worker:    NONE. Every provider failed or was skipped (exit 3).');
    L.push('next:      orchestrator does this task itself, or fix providers (conductor doctor)');
    return L.join('\n');
  }
  L.push(`worker:    ${s.winner} (${s.model})`);
  L.push(`report:    ${s.report}`);
  L.push(`status:    ${s.status || '(no RESULT/VERDICT line, so read the report)'}`);
  if (s.applied.length) L.push(`applied:   ${s.applied.join(', ')}`);
  if (s.rejected.length) L.push(`rejected:  ${s.rejected.join(', ')}`);
  if (s.mode === 'write') L.push(`changed:   ${s.changed.join(', ') || '(nothing)'}`);
  if (s.verify) L.push(`verify:    ${s.verify.status}${s.verify.cmd ? ` (${s.verify.cmd})` : ''}${s.verify.status === 'FAIL' ? `, log: ${s.verify.log}` : ''}${s.verify.note ? `, ${s.verify.note}` : ''}`);
  if (s.saved) L.push(`saved:     ${s.saved}`);
  for (const w of s.warnings) L.push(`WARNING:   ${w}`);
  L.push(s.mode === 'write'
    ? 'next:      orchestrator checks `git diff`, then commits, or retries with --provider <other> --note "<what was wrong>"'
    : 'next:      orchestrator reads the report and triages it. Workers can be wrong.');
  return L.join('\n');
}
