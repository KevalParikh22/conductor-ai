// The routing engine: role -> provider chain -> attempt with fallback -> verify -> summary.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, CLI_PRESETS } from './presets.js';
import { providerReadiness, providerKind, readOnlyEnforced, PROJECT_DIRNAME } from './config.js';
import { runProvider } from './providers.js';
import * as git from './git.js';
import { runVerify } from './verify.js';
import { autoModel } from './models.js';
import { smartOrder, isFree as isFreeProvider } from './selector.js';
import { taskProviders, matchRoute, describeRoute } from './routing.js';
import { compactDiff } from './diffview.js';
import { createWorktree, commitWorktree, removeWorktree } from './worktree.js';
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
 */
export function trimReport(text, maxBytes = 8000) {
  const at = text.search(/^#{0,4}\s*(RESULT|VERDICT):/m);
  let r = at > 0 ? text.slice(at) : text;
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
 * opts: role, task, planPath, taskId, provider, chain, note, files, base, focus, save, noVerify, allowDirty, onEvent,
 *       worktree (run in an isolated checkout on branch conductor/<id> and commit there), worktreeId, replace
 */
export async function dispatch(cfg, opts) {
  const { root, settings } = cfg;
  const role = opts.role;
  const meta = ROLES[role];
  if (!meta) throw new UsageError(`unknown role "${role}". Roles: ${Object.keys(ROLES).join(', ')}`);
  const mode = meta.mode;
  const emit = opts.onEvent || (() => {});
  const inRepo = git.isRepo(root);
  const useWorktree = !!opts.worktree;
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

  const agentPrompt = `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}\n---\n# TASK (role: ${role})\n${body}`;
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
    try { wt = createWorktree(root, opts.worktreeId || opts.taskId || `${role}-${stamp}`, { replace: opts.replace }); } catch (e) { throw new UsageError(e.message); }
    work = wt.dir;
    // keep the prompt file out of the main repo: agents that see its path may start working there instead
    ioDir = path.join(path.dirname(wt.dir), '.io', `${wt.id}-${stamp}`);
    fs.mkdirSync(ioDir, { recursive: true });
    mainBefore = new Set(git.status(root).split('\n').filter(Boolean));
    summary.worktree = { id: wt.id, branch: wt.branch, dir: wt.dir, base: wt.base.slice(0, 7), commit: null, linked: wt.linked };
    emit({ type: 'worktree', dir: wt.dir, branch: wt.branch });
  }
  const quotaRe = new RegExp(settings.quotaPattern, 'i');
  const timeoutMs = (settings.timeoutSec || 1200) * 1000;
  const picked = chooseChain(cfg, role, { provider: opts.provider, chain: opts.chain, section, body, files: [...(opts.files || []), ...taskFiles(section)], diffBytes });
  const chain = picked.chain;
  if (picked.how === 'selector' && picked.note) summary.selector = picked.note;
  if (picked.how === 'plan' || picked.how === 'route') summary.route = picked.note;
  // files already modified before the run (allowed with --allow-dirty): can't be credited to the worker
  const preDirty = mode === 'write' && inRepo ? new Set(git.changedFiles(work)) : new Set();
  let winnerText = '', lastPromptChars = 0;
  // hooks and .git/config can run programs: snapshot them so whatever a worker writes there is undone
  const control = inRepo ? git.snapshotControl(work) : null;
  const headBefore = inRepo ? git.head(work) : '';
  const hooksRel = inRepo ? git.repoHooksPath(work) : null;
  const protectedExtra = [...(settings.protectedPaths || []), ...(hooksRel ? [`^${hooksRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`] : [])];

  for (const c of chain) {
    if (c.skip) { summary.attempts.push({ provider: c.name, ok: false, reason: c.skip, skipped: true }); emit({ type: 'skip', provider: c.name, reason: c.skip }); continue; }
    const kind = providerKind(c.p);
    if (mode === 'read' && kind === 'agent' && !readOnlyEnforced(c.p)) {
      summary.warnings.push(`${c.name} cannot be held to read-only (only the prompt asks it not to edit). Check git status after this run`);
    }
    emit({ type: 'try', provider: c.name, kind });
    const before = inRepo ? git.stateHash(work) : null;
    const t0 = Date.now();
    // chat APIs, and agents whose read mode has no tools (goose), get the project context inlined
    const inline = kind === 'chat' || (mode === 'read' && CLI_PRESETS[c.p.preset]?.readInlineContext);
    const userPrompt = inline ? `${chatContext()}\n---\n# TASK (role: ${role})\n${body}` : agentPrompt;
    lastPromptChars = userPrompt.length;
    // an API provider without a model gets the best one from its live list (cached for a day)
    const p = kind === 'chat' && !c.p.model ? { ...c.p, model: await autoModel(c.name, c.p) } : c.p;
    let res = kind === 'chat' && !p.model
      ? { ok: false, text: '', reason: 'no model set, and its model list could not be fetched', log: '' }
      : await runProvider(c.name, p, { mode, prompt: userPrompt, system: chatSystem, cwd: work, runDir: ioDir, quotaRe,
        // an API call that stalls (free routes sometimes do) should fall back long before an agent's timeout
        timeoutMs: kind === 'chat' ? Math.min(timeoutMs, (settings.apiTimeoutSec || 300) * 1000) : timeoutMs });
    if (p !== c.p && p.model && !res.model) res.model = p.model;
    const tampered = control ? git.restoreControl(control) : [];
    if (tampered.length) summary.warnings.push(`${c.name} changed git hooks or config, which can run programs. conductor put them back: ${tampered.join(', ')}`);
    if (headBefore && git.head(work) !== headBefore) summary.warnings.push(`${c.name} made git commits itself (HEAD moved from ${headBefore.slice(0, 8)}). Check them with git log before merging`);
    fs.writeFileSync(path.join(runDir, `${c.name}.log`), res.log || '');

    if (res.ok && kind === 'chat' && mode === 'write') {
      const blocks = parseFileBlocks(res.text);
      const { applied, rejected } = applyFileBlocks(work, blocks, protectedExtra);
      summary.rejected.push(...rejected);
      if (!applied.length) res = { ...res, ok: false, reason: rejected.length ? 'only protected/outside files returned' : 'no file blocks in reply' };
      else summary.applied = applied;
    }
    const attempt = { provider: c.name, kind, ok: res.ok, reason: res.ok ? 'ok' : res.reason, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    if (res.tokens) { attempt.tokens = res.tokens; attempt.cost = estimateCost(c.p, res.tokens); }
    recordUsage({ provider: c.name, model: res.model || c.p.model || null, kind: kind === 'agent' ? 'agent' : 'chat', role, project: path.basename(root),
      ok: res.ok, reason: attempt.reason, seconds: attempt.seconds, tokens: res.tokens || null, cost: attempt.cost ?? null });
    const changedDuringRead = mode === 'read' && inRepo && before !== git.stateHash(work);
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
    if (mode === 'write' && (useWorktree || !opts.allowDirty) && git.isDirty(work)) {
      if (git.stashPush(work, `conductor: failed attempt by ${c.name} ${opts.taskId || role} ${timestamp()}`)) attempt.stashed = true;
    }
    summary.attempts.push(attempt);
    emit({ type: 'fail', provider: c.name, reason: attempt.reason });
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
    if (useWorktree) { removeWorktree(root, summary.worktree.id, { force: true }); summary.worktree.removed = true; }
    writeJSON(path.join(runDir, 'summary.json'), summary);
    return summary;
  }

  // the controller reads report.md: keep it to the worker's structured answer; the full output stays in the run folder
  const reportPath = path.join(runDir, 'report.md');
  const report = trimReport(winnerText, settings.maxReportBytes || 8000);
  fs.writeFileSync(reportPath, report);
  if (report.length < winnerText.length) fs.writeFileSync(path.join(runDir, 'report.full.md'), winnerText);
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
      const ev = checkEvidence(winnerText, summary.changed, summary.status, preDirty);
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
    }
    if (useWorktree) {
      const v = summary.verify ? `verify ${summary.verify.status}` : 'not verified';
      summary.worktree.commit = commitWorktree(work, `conductor: ${opts.taskId || role} by ${summary.winner} (${v})\n\n${(summary.status || '').replace(/^#+\s*/, '')}`);
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

/**
 * Paths a worker lists under "## Files changed" in its report, or null when the report has no such section.
 * Accepts "- path — summary", "- `path`: summary", "* path".
 */
export function claimedFiles(report) {
  const m = report.match(/^#{1,4}\s*Files changed\s*$([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/mi);
  if (!m) return null;
  const files = [];
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*[-*+]\s+`?([^`\s:—–]+?)`?(?:\s|:|$)/);
    if (!item || /^\(?(none|nothing|n\/a)\)?\.?$/i.test(item[1])) continue;
    files.push(item[1].replace(/^\.\//, ''));
  }
  return files;
}

/**
 * Evidence check: does the worker's report match what git shows? Claims are not trusted on their own.
 * Returns warnings plus the details for the summary.
 */
export function checkEvidence(report, changed, status, preDirty = new Set()) {
  const claimed = claimedFiles(report);
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
  L.push(`attempts:  ${s.attempts.map((a) => `${a.provider}(${a.reason}${a.stashed ? ', stashed' : ''})`).join(' → ') || '(none)'}`);
  if (!s.winner) {
    L.push('worker:    NONE. Every provider failed or was skipped (exit 3).');
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
  if (s.applied.length) L.push(`applied:   ${s.applied.join(', ')}`);
  if (s.rejected.length) L.push(`rejected:  ${s.rejected.join(', ')}`);
  if (s.mode === 'write') L.push(`changed:   ${s.changed.join(', ') || '(nothing)'}`);
  if (s.verify) L.push(`verify:    ${s.verify.status}${s.verify.scope === 'task' ? ' [task verify]' : ''}${s.verify.cmd ? ` (${s.verify.cmd})` : ''}${s.verify.status === 'FAIL' ? `, log: ${s.verify.log}` : ''}${s.verify.note ? `, ${s.verify.note}` : ''}`);
  if (s.saved) L.push(`saved:     ${s.saved}`);
  if (s.tokensSaved?.tokens) L.push(`tokens:    ~${s.tokensSaved.tokens.toLocaleString()} saved (estimate: ${Object.entries(s.tokensSaved).filter(([k]) => k !== 'tokens').map(([k, n]) => `${{ report: 'report trimmed', 'review-diff': 'compact review diff', 'free-model': 'free model chosen' }[k] || k} ~${n.toLocaleString()}`).join(', ')})`);
  if (s.worktree?.commit) L.push(`commit:    ${s.worktree.commit} on ${s.worktree.branch} (from ${s.worktree.base})`);
  for (const w of s.warnings) L.push(`WARNING:   ${w}`);
  if (s.worktree) {
    L.push(s.worktree.commit
      ? `next:      orchestrator reviews \`conductor diff ${s.worktree.branch}\`, then \`git merge --no-ff ${s.worktree.branch}\` and \`conductor worktree rm ${s.worktree.id}\` (or rm --force to reject)`
      : `next:      the worker changed nothing; \`conductor worktree rm ${s.worktree.id}\``);
    return L.join('\n');
  }
  L.push(s.mode === 'write'
    ? 'next:      orchestrator checks `conductor diff`, then commits, or retries with --provider <other> --note "<what was wrong>"'
    : 'next:      orchestrator reads the report and triages it. Workers can be wrong.');
  return L.join('\n');
}
