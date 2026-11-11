// The routing engine: role -> provider chain -> attempt with fallback -> verify -> summary.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, CLI_PRESETS, BUILD_COMMANDS } from './presets.js';
import { providerReadiness, providerKind, readOnlyEnforced, PROJECT_DIRNAME } from './config.js';
import { runProvider } from './providers.js';
import * as git from './git.js';
import { runVerify } from './verify.js';
import { autoModel, autoFallbacks } from './models.js';
import { smartOrder, isFree as isFreeProvider } from './selector.js';
import { taskProviders, matchRoute, describeRoute } from './routing.js';
import { compactDiff } from './diffview.js';
import { snapshot as snapshotLocal } from './localfiles.js';
import { skillsForTask } from './skills.js';
import { createWorktree, openWorktree, commitWorktree, removeWorktree, readWorktreeMeta, writeWorktreeMeta } from './worktree.js';
import { GLOBAL_DIR, readJSON, writeJSON, timestamp, rel } from './util.js';
import { budgetBlock, estimateCost, recordUsage, recordSaving } from './usage.js';

const PROMPTS = new URL('./prompts/', import.meta.url);
const loadPrompt = (n) => fs.readFileSync(new URL(`${n}.md`, PROMPTS), 'utf8');

export class UsageError extends Error {}

// Files workers must never touch (agents are told; chat output is filtered).
const PROTECTED = [/^AGENTS\.md$/, /^CLAUDE\.md$/, /^GEMINI\.md$/, /^HANDOFF\.md$/, /^docs\/plan\//, /^\.claude\//, /^\.gemini\//, /^\.agents\//,
  /^\.conductor\//, /^\.git\//, /^\.husky\//, /^\.githooks\//, /^\.vscode\/mcp\.json$/, /^\.mcp\.json$/, /(^|\/)node_modules\//, /(^|\/)\.env(\.|$)/, /(^|\/)auth\.json$/];
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

/**
 * Unresolved items under "## Open questions" in a plan: "- [ ] ..." lines. Resolved ones are "- [x] ... → answer".
 * Workers must not guess at open questions, so write tasks from a plan with any left are refused.
 */
export function openQuestions(planText) {
  return extractSection(planText, 'Open questions').split('\n')
    .map((l) => l.match(/^\s*[-*]\s*\[ \]\s*(.+)$/)?.[1]?.trim())
    .filter((q) => q && !/^<.*>$/.test(q));
}

/**
 * The part of a worker's output the controller needs: from its RESULT/VERDICT line on (agents often print their
 * whole transcript before it), capped at maxBytes. Falls back to the end of the output.
 * Findings or notes the worker wrote before that line are kept too, and a bare "VERDICT: CHANGES_REQUESTED"
 * (or a PARTIAL/BLOCKED result) with nothing after it gets the end of the output before it.
 */
export function trimReport(text, maxBytes = 8000) {
  const at = text.search(/^#{0,4}\s*(RESULT|VERDICT):/m);
  let r = at > 0 ? text.slice(at) : text;
  if (at > 0) {
    const before = text.slice(0, at);
    const kept = [];
    for (const name of ['Findings', 'Notes']) {
      if (new RegExp(`^#{1,4}\\s*${name}\\b`, 'mi').test(r)) continue;
      const last = [...before.matchAll(new RegExp(`^#{1,4}\\s*${name}\\b[^\\n]*\\n[\\s\\S]*?(?=^#{1,2}\\s|(?![\\s\\S]))`, 'gmi'))].at(-1);
      if (last && last[0].trim().split('\n').length > 1) kept.push(last[0].trim());
    }
    if (kept.length) r = `${r.trimEnd()}\n\n${kept.join('\n\n')}\n`;
    else if (/CHANGES_REQUESTED|PARTIAL|BLOCKED|FAIL/i.test(r.split('\n')[0]) && r.trim().split('\n').length < 3) {
      r = `${r.trimEnd()}\n\n## Output before the verdict (last part; full output: report.full.md)\n${before.slice(-4000).trim()}\n`;
    }
  }
  if (r.length > maxBytes) r = at >= 0 ? r.slice(0, maxBytes) + `\n… [cut at ${maxBytes} characters; full output: report.full.md]\n` : `[… start cut; full output: report.full.md]\n` + r.slice(-maxBytes);
  return r;
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
/**
 * Which providers take this task, in order, and why. Highest precedence first: an explicit chain, a provider
 * given on the command line, the plan task's "provider:" line, a matching route in config, then the smart
 * selector over the role's chain. Returns { chain (resolved entries), how, note }.
 */
export function chooseChain(cfg, role, { provider, chain, section = '', body = '', files = [], diffBytes = 0 } = {}) {
  if (chain?.length) return { chain: resolveChain(cfg, role, { chain }), how: 'chain', note: 'chain given' };
  if (provider) return { chain: resolveChain(cfg, role, { provider }), how: 'provider', note: `${provider} first (--provider)` };
  const own = cfg.roles[role] || [];
  const pinned = taskProviders(section);
  if (pinned.length) return { chain: resolveChain(cfg, role, { chain: [...pinned, ...own.filter((n) => !pinned.includes(n))] }), how: 'plan', note: `plan says ${pinned.join(', ')}` };
  const hit = matchRoute(cfg.routes, { role, body: `${body}\n${section}`, files });
  if (hit?.providers.length) return { chain: resolveChain(cfg, role, { chain: [...hit.providers, ...own.filter((n) => !hit.providers.includes(n))] }), how: 'route', note: `route ${hit.index + 1}: ${describeRoute(hit.route)}` };
  const base = resolveChain(cfg, role, {});
  if (cfg.settings?.smartSelect === false) return { chain: base, how: 'role', note: '' };
  const pick = smartOrder(base, { role, mode: ROLES[role]?.mode, body, files, diffBytes });
  return { chain: pick.chain, how: pick.note ? 'selector' : 'role', note: pick.note };
}
/**
 * How a finished run ended: 'done', 'partial' (the worker says it did only part: RESULT PARTIAL / BLOCKED /
 * FAILED), 'verify-failed' (it finished but the checks fail), 'unverified' (it wrote code but no verify ran, so
 * nothing proves it works) or 'failed' (no provider finished).
 */
export function outcome(s) {
  if (!s?.winner) return 'failed';
  if (s.verify?.status === 'FAIL') return 'verify-failed';
  if (/RESULT:\s*\**\s*(PARTIAL|BLOCKED|FAILED|FAIL)\b/i.test(s.status || '')) return 'partial';
  // no proof, no "done": code a worker wrote counts as done only when verify ran and passed
  if (isWriteRun(s) && s.verify?.status !== 'PASS') return 'unverified';
  return 'done';
}

const WRITE_ROLES = new Set(['build', 'fix', 'test', 'docs']);
const isWriteRun = (s) => (s.mode ? s.mode === 'write' : WRITE_ROLES.has(s.role));

/** Exit code 4: a worker finished but nothing proved its work (no verify command), and the caller didn't choose that. */
export const EXIT_UNVERIFIED = 4;
export function unverifiedBlocks(s, { allowUnverified = false } = {}) {
  return outcome(s) === 'unverified' && !allowUnverified && !s.verify?.chosen;
}

/** Commands write workers may run without a permission prompt: the usual build/test tools, the verify command, allowCommands. */
export function buildCommands(settings) {
  const verify = String(settings.verify || '').split(/&&|\|\||;|\|/).map((c) => c.trim()).filter(Boolean);
  return [...new Set([...BUILD_COMMANDS, ...verify, ...(settings.allowCommands || [])])];
}

const modelKey = (name, model) => `${name}@${model || '(default)'}`;

/**
 * Models to try on one provider, in order: its model (or the best from its live list when blank), then
 * fallbackModels. Free and auto-picked API providers get fallbacks from their live list when none are set.
 * Agents take fallbacks only when their preset can pass a model. Rate-limited models are left out.
 */
export async function modelsToTry(name, p, kind) {
  let first = p.model || '';
  let rest = Array.isArray(p.fallbackModels) ? p.fallbackModels.filter(Boolean) : [];
  if (kind === 'chat' && !first) first = await autoModel(name, p);
  if (kind === 'agent' && !(CLI_PRESETS[p.preset]?.modelArgs?.length || p.modelArgs?.length)) rest = [];
  const all = [...new Set([first, ...rest])];
  const cooling = getCooldowns();
  const left = all.filter((m) => !cooling[modelKey(name, m)]);
  // with no fallbacks of its own, a free or auto-picked API provider looks some up, but only once one is needed
  const auto = kind === 'chat' && !rest.length && p.autoFallback !== false && (!p.model || p.free)
    ? async () => (await autoFallbacks(name, p, { freeOnly: !!p.free, except: first })).filter((m) => !cooling[modelKey(name, m)] && !all.includes(m))
    : null;
  return { models: all.length > 1 || auto ? left : all, auto };
}

/** "90m", "1h", "1h30m", "2 hours", "45 min", "1.5h" → milliseconds (0 when it can't be read). */
export function parseDuration(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase().replace(/`/g, '').trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60_000; // a bare number is minutes
  let ms = 0, any = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])/g)) {
    any = true;
    ms += Number(m[1]) * (m[2][0] === 'h' ? 3_600_000 : m[2][0] === 'm' ? 60_000 : 1000);
  }
  return any ? Math.round(ms) : 0;
}

/**
 * How long one worker may run before it is stopped and the next provider takes over.
 * --timeout wins. Otherwise the provider's own timeoutMin, else settings.timeoutSec; a plan task's eta
 * raises that to eta × timeoutFactor, never lowers it. API calls are capped at apiTimeoutSec.
 */
export function workerTimeout(p, kind, settings, { etaMs = 0, timeoutMs = 0 } = {}) {
  if (kind === 'chat') {
    // free routes now and then hang for minutes: give up on them sooner and let the next model or provider try
    const sec = p.timeoutMin ? p.timeoutMin * 60 : p.free ? settings.freeApiTimeoutSec || 90 : settings.apiTimeoutSec || 300;
    return { timeoutMs: Math.min(timeoutMs || Infinity, sec * 1000) };
  }
  let limit = timeoutMs || (p.timeoutMin ? p.timeoutMin * 60_000 : (settings.timeoutSec || 1200) * 1000);
  if (!timeoutMs && etaMs) limit = Math.max(limit, Math.round(etaMs * (settings.timeoutFactor || 2)));
  const idleMin = p.idleTimeoutMin ?? (settings.idleTimeoutSec || 0) / 60;
  return { timeoutMs: limit, idleTimeoutMs: Math.round(idleMin * 60_000) };
}

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
    const over = budgetBlock(name, p, cfg.settings);
    if (over) return { name, p, skip: over };
    return { name, p };
  });
}

// never sent to an API model as context, even when asked to
const SECRET_PATHS = [/(^|\/)\.env(\.|$)/, /(^|\/)auth\.json$/, /(^|\/)secrets?\.env$/, /(^|\/)\.npmrc$/, /(^|\/)id_(rsa|ed25519|ecdsa)/, /\.(pem|key|p12|pfx)$/];

function readContextFiles(root, files, budget, extraSecret = []) {
  let out = '', used = 0;
  for (const f of [...new Set(files)]) {
    const abs = path.resolve(root, f);
    if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
    const norm = path.relative(root, abs).replaceAll('\\', '/');
    if (SECRET_PATHS.some((re) => re.test(norm)) || extraSecret.some((src) => new RegExp(src).test(norm))) { out += `\n### ${f}\n(withheld: looks like a secrets file)\n`; continue; }
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
 * opts: role, task, planPath, taskId, provider, chain, note, files, base, focus, save, noVerify, allowUnverified, allowDirty, onEvent,
 *       worktree (run in an isolated checkout on branch conductor/<id> and commit there), worktreeId, replace,
 *       continue (keep working in that task's existing worktree: a retry with a note, by the same worker by default)
 */
export async function dispatch(cfg, opts) {
  const { root, settings } = cfg;
  const role = opts.role;
  const meta = ROLES[role];
  if (!meta) throw new UsageError(`unknown role "${role}". Roles: ${Object.keys(ROLES).join(', ')}`);
  const mode = meta.mode;
  const emit = opts.onEvent || (() => {});
  const inRepo = git.isRepo(root);
  const useWorktree = !!(opts.worktree || opts.continue);
  const wtId = opts.worktreeId || opts.taskId;
  let prior = null;
  if (opts.continue) {
    if (!wtId) throw new UsageError('--continue needs the task id (--task T3) of the worktree to continue');
    prior = readWorktreeMeta(root, wtId);
    // the same worker fixes its own work unless another one is named
    if (!opts.provider && !opts.chain?.length && prior?.winner && cfg.providers[prior.winner]) opts = { ...opts, provider: prior.winner };
  }
  if (useWorktree && mode !== 'write') throw new UsageError(`--worktree is for write roles (build, fix, test, docs); ${role} is read-only and can already run in parallel`);
  const preWarnings = [];

  // ---- safety
  if (mode === 'write' && useWorktree) {
    // the worker gets its own checkout on its own branch, so the current branch and tree state don't matter
    if (!inRepo) throw new UsageError('--worktree needs a git repo');
    if (!git.hasCommits(root)) throw new UsageError('the repo has no commits yet: make an initial commit first');
    if (git.isDirty(root)) preWarnings.push('your working tree has uncommitted changes; the worktree starts from the last commit and does not include them');
  } else if (mode === 'write') {
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
  let diffBytes = 0, reviewSaved = 0; // full review diff size (for the selector) and what compacting it saved
  if (opts.planPath) {
    const planAbs = path.resolve(root, opts.planPath);
    if (!fs.existsSync(planAbs)) throw new UsageError(`plan not found: ${opts.planPath}`);
    planText = fs.readFileSync(planAbs, 'utf8');
  }
  if (role === 'review') {
    if (!inRepo) throw new UsageError('review needs a git repo');
    const base = opts.base || git.defaultBase(root);
    // compact: whitespace-only changes, lockfiles and build output left out (listed), 2 lines of context
    const cd = compactDiff(root, { base, maxFileLines: 400 });
    if (cd.empty) throw new UsageError(`nothing to review: no changes vs ${base}`);
    let diff = cd.text;
    diffBytes = cd.fullChars;
    reviewSaved = Math.max(0, cd.fullChars - cd.chars);
    const max = settings.maxDiffBytes || 100000;
    if (diff.length > max) diff = diff.slice(0, max) + `\n... [diff truncated at ${max} bytes: open the changed files directly for the rest]\n`;
    body = (opts.planPath ? `Plan file: ${opts.planPath}\n` : '') + (opts.focus ? `Extra focus: ${opts.focus}\n` : '') +
      (opts.task ? `Context from the orchestrator: ${opts.task}\n` : '') + `\n# DIFF (vs ${base})\n\`\`\`diff\n${diff}\n\`\`\`\n`;
  } else if (opts.taskId) {
    if (!planText) throw new UsageError('--task needs --plan');
    section = extractTask(planText, opts.taskId);
    if (!section) throw new UsageError(`task "${opts.taskId}" not found in ${opts.planPath} (expected a heading like "### ${opts.taskId}: title")`);
    const open = mode === 'write' ? openQuestions(planText) : [];
    if (open.length && !opts.allowOpenQuestions) {
      throw new UsageError(`${opts.planPath} still has ${open.length} open question(s): ${open.map((q) => `"${q}"`).join('; ')}. ` +
        'Answer them in the plan (mark "- [x] question → answer") before handing out tasks, or pass --allow-open-questions');
    }
    const notes = useWorktree ? extractSection(planText, 'Design notes') : '';
    body = useWorktree
      ? `Plan: ${opts.planPath} (its Design notes are copied below; the file itself may not exist in your checkout)\nYour task id: ${opts.taskId}\n\n## Design notes\n${notes || '(none)'}\n\n${section}\n`
      : `Plan file: ${opts.planPath} (read its Design notes)\nYour task id: ${opts.taskId}\n\n${section}\n`;
    if (opts.task) body += `\nAdditional instructions: ${opts.task}\n`;
  } else if (opts.task) {
    body = opts.task + '\n' + (opts.planPath ? `\nRelated plan file: ${opts.planPath}\n` : '');
  } else {
    throw new UsageError(role === 'ask' ? 'ask needs a question' : `${role} needs a task: --plan <file> --task <id>, or a task description`);
  }
  if (opts.note) body += `\n## Orchestrator note (important)\n${opts.note}\n`;
  let continueNote = '';

  // skills from the library that match this task: listed for agents (they open what they need), inlined for API models
  const skillTask = { role, files: [...(opts.files || []), ...taskFiles(section)], body };
  const skillsAgent = skillsForTask(root, skillTask), skillsChat = skillsForTask(root, skillTask, { inline: true });
  let agentPrompt = `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}\n---\n# TASK (role: ${role})\n${body}${skillsAgent.text ? `\n${skillsAgent.text}` : ''}`;
  const chatSystem = `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}${mode === 'write' ? '\n' + loadPrompt('_chat_write') : ''}`;
  let work = root; // where the worker runs: the repo, or its own worktree
  const chatContext = () => {
    let ctx = '';
    const agents = path.join(work, 'AGENTS.md');
    if (fs.existsSync(agents)) ctx += `# AGENTS.md (project rules, authoritative)\n${fs.readFileSync(agents, 'utf8').slice(0, 20000)}\n`;
    const notes = planText && extractSection(planText, 'Design notes');
    if (notes) ctx += `\n# Design notes from ${opts.planPath}\n${notes}\n`;
    const files = [...(opts.files || []), ...taskFiles(section)];
    if (files.length) ctx += `\n# Relevant files (current content)\n${readContextFiles(work, files, settings.maxContextBytes || 60000, settings.protectedPaths || [])}`;
    return ctx;
  };

  // ---- run dir
  const runsDir = path.join(root, PROJECT_DIRNAME, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  if (!fs.existsSync(path.join(runsDir, '.gitignore'))) fs.writeFileSync(path.join(runsDir, '.gitignore'), '*\n');
  const stamp = timestamp();
  const runDir = path.join(runsDir, `${stamp}-${role}${opts.taskId ? '-' + opts.taskId.replace(/[^\w.-]/g, '') : ''}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'task.md'), body);

  const summary = {
    role, mode, startedAt: new Date().toISOString(), task: opts.taskId || null, plan: opts.planPath || null, attempts: [], winner: null, model: null,
    report: null, status: null, changed: [], applied: [], rejected: [], warnings: [...preWarnings], verify: null, runDir: rel(root, runDir), exitCode: 3,
  };
  let ioDir = runDir; // where CLI workers get their prompt/output files
  let mainBefore = null;
  if (useWorktree) {
    let wt;
    try { wt = opts.continue ? openWorktree(root, wtId) : createWorktree(root, wtId || `${role}-${stamp}`, { replace: opts.replace }); } catch (e) { throw new UsageError(e.message); }
    if (!wt.continued) writeWorktreeMeta(root, wt.id, { role, plan: opts.planPath || null, task: opts.taskId || null });
    work = wt.dir;
    // keep the prompt file out of the main repo: agents that see its path may start working there instead
    ioDir = path.join(path.dirname(wt.dir), '.io', `${wt.id}-${stamp}`);
    fs.mkdirSync(ioDir, { recursive: true });
    mainBefore = new Set(git.status(root).split('\n').filter(Boolean));
    summary.worktree = { id: wt.id, branch: wt.branch, dir: wt.dir, base: wt.base.slice(0, 7), commit: null, linked: wt.linked, ...(wt.continued ? { continued: true } : {}) };
    if (wt.continued) {
      const done = git.diffStatVs(wt.dir, wt.base);
      continueNote = `\n## You are continuing this task\nThis checkout already holds the earlier work on it (branch ${wt.branch}). Do not start over: review what is there, keep what is right and fix what the orchestrator note asks.\n${done ? `Changed so far (vs ${wt.base.slice(0, 7)}):\n\`\`\`\n${done}\n\`\`\`\n` : ''}`;
      body += continueNote;
      agentPrompt += continueNote;
    }
    emit({ type: 'worktree', dir: wt.dir, branch: wt.branch });
  }
  const quotaRe = new RegExp(settings.quotaPattern, 'i');
  const etaMs = parseDuration((section.match(/\*\*eta:\*\*\s*([^\n]+)/i) || [])[1]);
  const limitFor = (p, kind) => workerTimeout(p, kind, settings, { etaMs, timeoutMs: opts.timeoutMs });
  const picked = chooseChain(cfg, role, { provider: opts.provider, chain: opts.chain, section, body, files: [...(opts.files || []), ...taskFiles(section)], diffBytes });
  const chain = picked.chain;
  if (picked.how === 'selector' && picked.note) summary.selector = picked.note;
  if (skillsAgent.names.length) summary.skills = skillsAgent.names;
  if (picked.how === 'plan' || picked.how === 'route') summary.route = picked.note;
  // files already modified before the run (allowed with --allow-dirty): can't be credited to the worker
  const preDirty = mode === 'write' && inRepo ? new Set(git.changedFiles(work)) : new Set();
  let winnerText = '', lastPromptChars = 0;
  // hooks and .git/config can run programs: snapshot them so whatever a worker writes there is undone
  const control = inRepo ? git.snapshotControl(work) : null;
  // conductor's git-ignored files (AGENTS.md, plans, skills): git can't see a worker's edits there, so keep a copy
  const restoreLocal = snapshotLocal(root, work);
  const headBefore = inRepo ? git.head(work) : '';
  const hooksRel = inRepo ? git.repoHooksPath(work) : null;
  const protectedExtra = [...(settings.protectedPaths || []), ...(hooksRel ? [`^${hooksRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`] : [])];

  providers: for (const c of chain) {
    if (c.skip) { summary.attempts.push({ provider: c.name, ok: false, reason: c.skip, skipped: true }); emit({ type: 'skip', provider: c.name, reason: c.skip }); continue; }
    const kind = providerKind(c.p);
    if (mode === 'read' && kind === 'agent' && !readOnlyEnforced(c.p)) {
      summary.warnings.push(`${c.name} cannot be held to read-only (only the prompt asks it not to edit). Check git status after this run`);
    }
    // chat APIs, and agents whose read mode has no tools (goose), get the project context inlined
    const inline = kind === 'chat' || (mode === 'read' && CLI_PRESETS[c.p.preset]?.readInlineContext);
    const userPrompt = inline ? `${chatContext()}\n---\n# TASK (role: ${role})\n${body}${skillsChat.text ? `\n${skillsChat.text}` : ''}` : agentPrompt;
    // the provider's model, then its fallback models: a model that is rate-limited is skipped until its cooldown ends
    let { models, auto } = await modelsToTry(c.name, c.p, kind);
    let timeouts = 0;
    if (!models.length) {
      const reason = 'every model is cooling down';
      summary.attempts.push({ provider: c.name, ok: false, reason, skipped: true }); emit({ type: 'skip', provider: c.name, reason });
      continue;
    }
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      emit({ type: 'try', provider: c.name, kind, model: mi ? model : undefined });
      const before = inRepo ? git.stateHash(work) : null;
      const t0 = Date.now();
      lastPromptChars = userPrompt.length;
      const p = model === (c.p.model || '') ? c.p : { ...c.p, model };
      let res = kind === 'chat' && !p.model
        ? { ok: false, text: '', reason: 'no model set, and its model list could not be fetched', log: '' }
        : await runProvider(c.name, p, { mode, prompt: userPrompt, system: chatSystem, cwd: work, runDir: ioDir, quotaRe,
          allowCommands: buildCommands(settings), ...limitFor(c.p, kind) });
      if (p !== c.p && p.model && !res.model) res.model = p.model;
      const tampered = control ? git.restoreControl(control) : [];
      const putBack = restoreLocal();
      if (putBack.length) summary.warnings.push(`${c.name} changed conductor's own files, which workers must not edit. conductor put them back: ${putBack.join(', ')}`);
      if (tampered.length) summary.warnings.push(`${c.name} changed git hooks or config, which can run programs. conductor put them back: ${tampered.join(', ')}`);
      if (headBefore && git.head(work) !== headBefore) summary.warnings.push(`${c.name} made git commits itself (HEAD moved from ${headBefore.slice(0, 8)}). Check them with git log before merging`);
      fs.writeFileSync(path.join(runDir, `${c.name}${mi ? `.${mi + 1}` : ''}.log`), res.log || '');

      if (res.ok && kind === 'chat' && mode === 'write') {
        const blocks = parseFileBlocks(res.text);
        const { applied, rejected } = applyFileBlocks(work, blocks, protectedExtra);
        summary.rejected.push(...rejected);
        if (!applied.length) res = { ...res, ok: false, reason: rejected.length ? 'only protected/outside files returned' : 'no file blocks in reply' };
        else summary.applied = applied;
      }
      const attempt = { provider: c.name, kind, ok: res.ok, reason: res.ok ? 'ok' : res.reason, seconds: Math.round((Date.now() - t0) / 100) / 10 };
      if (p.model) attempt.model = p.model;
      if (res.tokens) { attempt.tokens = res.tokens; attempt.cost = estimateCost(c.p, res.tokens); }
      recordUsage({ provider: c.name, model: res.model || p.model || null, kind: kind === 'agent' ? 'agent' : 'chat', role, project: path.basename(root),
        ok: res.ok, reason: attempt.reason, seconds: attempt.seconds, tokens: res.tokens || null, cost: attempt.cost ?? null });
      const changedDuringRead = mode === 'read' && inRepo && before !== git.stateHash(work);
      if (changedDuringRead) summary.warnings.push(`${c.name} changed files during a read-only run. Check git status.`);

      if (res.ok) {
        summary.attempts.push(attempt);
        summary.winner = c.name; summary.model = res.model || p.model || '(default)';
        winnerText = res.text;
        emit({ type: 'ok', provider: c.name });
        break providers;
      }
      const quota = res.reason === 'quota';
      // another model can help when this one is rate-limited, or (for APIs) when it stalled or answered nothing
      const timedOut = /^timeout/.test(res.reason || '');
      if (timedOut) timeouts++;
      // one more model after a timeout; a second timeout means the provider itself is hanging, so move on
      const modelProblem = quota || (kind === 'chat' && /^(timeout|empty output|server 5)/.test(res.reason || '') && timeouts < 2);
      if (modelProblem && mi === models.length - 1 && auto) { models = [...models, ...(await auto())]; auto = null; }
      const nextModel = models[mi + 1];
      const tryNext = nextModel !== undefined && modelProblem;
      if (quota) {
        const mins = res.retryAfterSec ? Math.max(1, Math.ceil(res.retryAfterSec / 60)) : (settings.cooldownMinutes || 30);
        if (models.length > 1 || mi) setCooldown(modelKey(c.name, p.model), mins, 'rate limited');
        // the provider itself cools down only when it has no other model left to try
        if (!tryNext) setCooldown(c.name, mins, 'rate limited');
        attempt.reason += ` (cooldown ${mins}m)`;
      }
      if (mode === 'write' && (useWorktree || !opts.allowDirty) && git.isDirty(work)) {
        if (git.stashPush(work, `conductor: failed attempt by ${c.name} ${opts.taskId || role} ${timestamp()}`)) attempt.stashed = true;
      }
      summary.attempts.push(attempt);
      emit({ type: 'fail', provider: c.name, reason: attempt.reason + (tryNext ? `, trying model ${nextModel}` : '') });
      if (!tryNext) break;
    }
  }

  if (useWorktree) {
    fs.rmSync(ioDir, { recursive: true, force: true });
    const leaked = git.status(root).split('\n').filter((l) => l && !mainBefore.has(l)).map((l) => l.slice(3));
    if (leaked.length) {
      summary.leaked = leaked;
      summary.warnings.push(`files appeared in your MAIN checkout during this run (from this worker, or another one running at the same time): ${leaked.join(', ')}. Inspect them with git status before merging`);
    }
  }
  if (!summary.winner) {
    // a fresh worktree with nothing in it goes; a continued one keeps the earlier work
    if (useWorktree && !summary.worktree.continued) { removeWorktree(root, summary.worktree.id, { force: true }); summary.worktree.removed = true; }
    writeJSON(path.join(runDir, 'summary.json'), summary);
    return summary;
  }

  // the controller reads report.md: keep it to the worker's structured answer; the full output stays in the run folder
  const reportPath = path.join(runDir, 'report.md');
  const report = trimReport(winnerText, settings.maxReportBytes || 8000);
  fs.writeFileSync(reportPath, report);
  if (report !== winnerText) fs.writeFileSync(path.join(runDir, 'report.full.md'), winnerText);
  // estimated tokens kept out of a model's context by this run
  const proj = path.basename(root);
  const saved = { report: recordSaving({ source: 'report', chars: winnerText.length - report.length, project: proj }), 'review-diff': recordSaving({ source: 'review-diff', chars: reviewSaved, project: proj }) };
  const win = summary.attempts.at(-1);
  if (summary.selector && win && isFreeProvider(cfg.providers[win.provider]) && !isFreeProvider(cfg.providers[(cfg.roles[role] || []).find((n) => providerReadiness(n, cfg.providers[n] || {}).ready)] || {})) {
    saved['free-model'] = recordSaving({ source: 'free-model', tokens: (win.tokens?.input || 0) + (win.tokens?.output || 0) || Math.round((lastPromptChars + winnerText.length) / 4), project: proj });
  }
  const savedTotal = Object.values(saved).reduce((t, n) => t + n, 0);
  if (savedTotal) summary.tokensSaved = { tokens: savedTotal, ...Object.fromEntries(Object.entries(saved).filter(([, n]) => n)) };
  summary.report = rel(root, reportPath);
  summary.status = (winnerText.match(/^#*\s*(RESULT|VERDICT):.*$/m) || [null])[0];
  summary.exitCode = 0;

  if (mode === 'write') {
    summary.changed = git.changedFiles(work);
    const touched = summary.changed.filter((f) => isProtected(f, protectedExtra));
    if (touched.length) summary.warnings.push(`worker modified protected files: ${touched.join(', ')}`);
    if (summary.attempts.at(-1)?.kind === 'agent') { // chat replies are applied from their file blocks, so they can't misreport
      const ev = checkEvidence(winnerText, summary.changed, summary.status, preDirty, [work, root]);
      summary.evidence = { claimed: ev.claimed, notChanged: ev.notChanged, notReported: ev.notReported };
      summary.warnings.push(...ev.warnings);
    }
    if (settings.autoVerify !== false && !opts.noVerify) {
      emit({ type: 'verify' });
      // in a worktree, other parallel tasks' work is missing, so prefer the task's own verify line from the plan
      const taskVerify = useWorktree ? (section.match(/\*\*verify:\*\*\s*`([^`]+)`/i) || [])[1]?.trim() : '';
      const vs = taskVerify && !taskVerify.includes('<') ? { ...settings, verify: taskVerify } : settings;
      summary.verify = await runVerify(work, vs, path.join(runDir, 'verify.log'));
      if (vs !== settings) summary.verify.scope = 'task';
      if (summary.verify.log) summary.verify.log = rel(root, summary.verify.log);
    } else {
      // skipped on purpose: the outcome is still "unverified", but it doesn't fail the run
      summary.verify = { status: 'SKIPPED', cmd: '', chosen: true, note: opts.noVerify ? 'skipped with --no-verify' : 'autoVerify is off in settings' };
    }
    if (useWorktree) {
      const v = summary.verify ? `verify ${summary.verify.status}` : 'not verified';
      writeWorktreeMeta(root, summary.worktree.id, { winner: summary.winner, model: summary.model });
      summary.worktree.commit = commitWorktree(work, `conductor: ${opts.taskId || role}${summary.worktree.continued ? ' (continued)' : ''} by ${summary.winner} (${v})\n\n${(summary.status || '').replace(/^#+\s*/, '')}`);
    }
  }
  if (opts.save) {
    const dest = path.resolve(root, opts.save);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, winnerText);
    summary.saved = rel(root, dest);
  }
  summary.outcome = outcome(summary);
  if (unverifiedBlocks(summary, { allowUnverified: opts.allowUnverified || settings.allowUnverified })) summary.exitCode = EXIT_UNVERIFIED;
  writeJSON(path.join(runDir, 'summary.json'), summary);
  return summary;
}

/** "src/{a,b}.ts" → ["src/a.ts", "src/b.ts"] (nested groups too). */
export function expandBraces(p) {
  const m = p.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m || !m[2].includes(',')) return [p];
  return [...new Set(m[2].split(',').flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`)))];
}

/**
 * Paths a worker lists under "## Files changed" in its report, or null when the report has no such section.
 * Accepts "- path — summary", "- `path`: summary", "* path", "- `a.ts`, `b.ts`", markdown links
 * "[a.ts](file:///…/a.ts)", absolute paths (made relative to `roots`), "src/{a,b}.ts" and "a.ts:12".
 * Words that aren't paths ("No", "Tabs") are skipped unless they name a file in `known`.
 */
export function claimedFiles(report, { roots = [], known = [] } = {}) {
  const m = report.match(/^#{1,4}\s*Files changed\s*$([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/mi);
  if (!m) return null;
  const bases = [...new Set(roots.flatMap((r) => { try { return [r, fs.realpathSync(r)]; } catch { return [r]; } }))].map((r) => r.replace(/\/+$/, ''));
  const knownSet = new Set(known);
  const files = [];
  const clean = (raw) => {
    let p = decodeURIComponent(raw.trim()).replace(/^file:\/\//, '').replace(/^\*\*|\*\*$/g, '').replace(/[),.;:]+$/, '');
    p = p.replace(/#L?\d+(-L?\d+)?$/, '').replace(/:\d+(:\d+)?$/, '');
    if (path.isAbsolute(p)) {
      const base = bases.find((b) => p === b || p.startsWith(b + '/'));
      if (!base) return null; // outside the project
      p = p.slice(base.length + 1);
    }
    p = p.replace(/^\.\//, '');
    if (!p || /^\(?(none|nothing|n\/a)\)?\.?$/i.test(p)) return null;
    return p;
  };
  const looksLikePath = (p) => knownSet.has(p) || /\//.test(p) || /\.[A-Za-z0-9_-]{1,10}$/.test(p) || /^(Dockerfile|Makefile|Procfile|Gemfile|Rakefile)$/.test(p);
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!item) continue;
    const text = item[1];
    let raw = [...text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((l) => (/^https?:/.test(l[2]) ? l[1] : l[2]));
    if (!raw.length) raw = [...text.matchAll(/`([^`]+)`/g)].map((b) => b[1]).filter((b) => !/\s/.test(b.trim()));
    if (!raw.length) raw = [text.trim().split(/\s+/)[0]];
    // a backticked or linked path list may be followed by prose; only the first group of paths counts
    for (const r of raw) {
      for (const one of expandBraces(r.replace(/^\*\*|\*\*$/g, ''))) {
        const p = clean(one);
        if (p && looksLikePath(p) && !files.includes(p)) files.push(p);
      }
    }
  }
  return files;
}

/**
 * Evidence check: does the worker's report match what git shows? Claims are not trusted on their own.
 * Returns warnings plus the details for the summary.
 */
export function checkEvidence(report, changed, status, preDirty = new Set(), roots = []) {
  const claimed = claimedFiles(report, { roots, known: changed });
  const actual = new Set(changed);
  const warnings = [];
  if (/RESULT:\s*DONE/i.test(status || '') && !changed.length) warnings.push('the worker reports DONE but changed no files');
  changed = changed.filter((f) => !preDirty.has(f)); // their changes may be from before the run
  if (!claimed) return { claimed: null, notChanged: [], notReported: [], warnings };
  const claimedSet = new Set(claimed);
  const notChanged = claimed.filter((f) => !actual.has(f) && !changed.some((c) => c.startsWith(f.replace(/\/?$/, '/'))));
  const notReported = changed.filter((f) => !claimedSet.has(f) && ![...claimedSet].some((c) => f.startsWith(c.replace(/\/?$/, '/'))));
  if (notChanged.length) warnings.push(`the worker says it changed ${notChanged.join(', ')}, but git shows no change there`);
  if (notReported.length) warnings.push(`changed but not listed in the worker's report: ${notReported.join(', ')}`);
  return { claimed, notChanged, notReported, warnings };
}

export function formatSummary(s) {
  const L = [];
  L.push('', '==================== CONDUCTOR RESULT ====================');
  L.push(`role:      ${s.role}${s.task ? `   task: ${s.task}` : ''}${s.plan ? `   plan: ${s.plan}` : ''}`);
  if (s.worktree) L.push(`worktree:  ${s.worktree.branch}${s.worktree.removed ? ' (removed: nothing to keep)' : `  ${s.worktree.dir}`}`);
  if (s.route) L.push(`route:     ${s.route}`);
  if (s.selector) L.push(`selector:  ${s.selector}`);
  if (s.skills?.length) L.push(`skills:    ${s.skills.join(', ')}`);
  const multi = (n) => s.attempts.filter((a) => a.provider === n).length > 1; // show models only where a provider switched model
  L.push(`attempts:  ${s.attempts.map((a) => `${a.provider}${a.model && multi(a.provider) ? `[${a.model}]` : ''}(${a.reason}${a.stashed ? ', stashed' : ''})`).join(' → ') || '(none)'}`);
  if (!s.winner) {
    L.push('worker:    NONE. Every provider failed or was skipped (exit 3).');
    if (s.worktree?.continued) L.push(`kept:      the earlier work is still on ${s.worktree.branch}; failed attempts were stashed there`);
    L.push('next:      orchestrator does this task itself, or fix providers (conductor doctor)');
    return L.join('\n');
  }
  L.push(`worker:    ${s.winner} (${s.model})`);
  const used = s.attempts.filter((a) => a.tokens);
  if (used.length) {
    const tin = used.reduce((t, a) => t + (a.tokens.input || 0), 0), tout = used.reduce((t, a) => t + (a.tokens.output || 0), 0);
    const known = used.filter((a) => a.cost != null), cost = known.reduce((t, a) => t + a.cost, 0);
    L.push(`usage:     ${tin} tokens in / ${tout} out${known.length ? ` · $${cost.toFixed(4)}` : ' · cost unknown (no price set)'}`);
  }
  L.push(`report:    ${s.report}`);
  L.push(`status:    ${s.status || '(no RESULT/VERDICT line, so read the report)'}`);
  const out = outcome(s);
  if (out === 'partial') L.push('outcome:   PARTIAL. The worker says it did only part of the task: read the report, then finish it or retry the rest');
  if (out === 'verify-failed') L.push('outcome:   NOT DONE. The worker finished but verify fails: fix it, or retry with --note "<what failed>"');
  if (out === 'unverified') L.push(s.verify?.chosen
    ? 'outcome:   UNVERIFIED. Verify was skipped, so nothing proves this works: check it yourself before committing'
    : 'outcome:   UNVERIFIED (exit 4). No verify command, so nothing proves this works. Set one: conductor init --verify "<cmd>" (or the Verify line in AGENTS.md), then run conductor verify');
  if (s.applied.length) L.push(`applied:   ${s.applied.join(', ')}`);
  if (s.rejected.length) L.push(`rejected:  ${s.rejected.join(', ')}`);
  if (s.mode === 'write') L.push(`changed:   ${s.changed.join(', ') || '(nothing)'}`);
  if (s.verify) L.push(`verify:    ${s.verify.status}${s.verify.scope === 'task' ? ' [task verify]' : ''}${s.verify.cmd ? ` (${s.verify.cmd})` : ''}${s.verify.status === 'FAIL' ? `, log: ${s.verify.log}` : ''}${s.verify.note ? `, ${s.verify.note}` : ''}`);
  if (s.saved) L.push(`saved:     ${s.saved}`);
  if (s.tokensSaved?.tokens) L.push(`context:   ~${s.tokensSaved.tokens.toLocaleString()} tokens kept out (estimate: ${Object.entries(s.tokensSaved).filter(([k]) => k !== 'tokens').map(([k, n]) => `${{ report: 'report trimmed', 'review-diff': 'compact review diff', 'free-model': 'free model chosen' }[k] || k} ~${n.toLocaleString()}`).join(', ')})`);
  if (s.worktree?.commit) L.push(`commit:    ${s.worktree.commit} on ${s.worktree.branch} (from ${s.worktree.base})`);
  for (const w of s.warnings) L.push(`WARNING:   ${w}`);
  if (s.worktree) {
    L.push(s.worktree.commit
      ? `next:      orchestrator reviews \`conductor diff ${s.worktree.branch}\`, then \`git merge --no-ff ${s.worktree.branch}\` and \`conductor worktree rm ${s.worktree.id}\` (or rm --force to reject)`
      : s.worktree.continued
        ? `next:      nothing new this time; the earlier work is still on ${s.worktree.branch}. Retry with another note or provider, or merge it as it is`
        : `next:      the worker changed nothing; \`conductor worktree rm ${s.worktree.id}\``);
    return L.join('\n');
  }
  L.push(s.mode === 'write'
    ? 'next:      orchestrator checks `conductor diff`, then commits, or retries with --provider <other> --note "<what was wrong>"'
    : 'next:      orchestrator reads the report and triages it. Workers can be wrong.');
  return L.join('\n');
}
