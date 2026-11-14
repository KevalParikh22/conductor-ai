// The routing engine: role -> provider chain -> attempt with fallback -> verify -> summary.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROLES, CLI_PRESETS, controllerWorker, BUILD_COMMANDS } from './presets.js';
import { providerReadiness, providerKind, readOnlyEnforced, PROJECT_DIRNAME } from './config.js';
import { runProvider } from './providers.js';
import * as git from './git.js';
import { runVerify } from './verify.js';
import { baseVerify, scopeCheck, newFailures, syntaxErrors, missingContract, failureBrief, runRepro, proveRegression, verifyOnBase, TEST_FILE, unexported } from './gates.js';
import { checkTask, taskAcceptance, acceptancePrompt, readAcceptance } from './plancheck.js';
import { detectVerify } from './verify.js';
import { repoMap, contextPack } from './context.js';
import { runAcceptanceChecks, checksBrief, parseChecks } from './acceptcheck.js';
import { runSamples } from './samples.js';
import { independentReview, riskReasons } from './review.js';
import { lessonsPrompt, demoteByLessons, lessonsFromRun, addLesson, resolveLessons, promotable, readLessons, lessonMatches, GUIDANCE } from './lessons.js';
import { rulesPrompt } from './controllers.js';
import { recordVerify } from './guard.js';
import { autoModel, autoFallbacks, cliFallbacks } from './models.js';
import { smartOrder, taskSize, isFree as isFreeProvider } from './selector.js';
import { taskProviders, matchRoute, describeRoute } from './routing.js';
import { compactDiff } from './diffview.js';
import { snapshot as snapshotLocal } from './localfiles.js';
import { skillsForTask } from './skills.js';
import { createWorktree, openWorktree, commitWorktree, removeWorktree, readWorktreeMeta, writeWorktreeMeta } from './worktree.js';
import { writeJSON, timestamp, rel, untilText, run as runCmd } from './util.js';
import { budgetBlock, estimateCost, recordUsage, recordSaving } from './usage.js';
import { nextStep } from './nextsteps.js';
import { extractTask, extractSection, openQuestions, taskFiles, expandBraces, notesForFiles, parseDuration } from './plan.js';
import { getCooldowns, setCooldown, modelKey, withSlot } from './cooldowns.js';
import { outcome, EXIT_UNVERIFIED, unverifiedBlocks } from './outcome.js';
import { isProtected, trimReport, parseFileBlocks, applyFileBlocks, checkEvidence } from './files.js';
// moved out unchanged (V12); re-exported so every importer of core.js keeps working
export { extractTask, extractSection, openQuestions, taskFiles, expandBraces, notesForFiles, parseDuration } from './plan.js';
export { getCooldowns, setCooldown, clearCooldowns, withSlot } from './cooldowns.js';
export { outcome, EXIT_UNVERIFIED, unverifiedBlocks } from './outcome.js';
export { isProtected, trimReport, parseFileBlocks, applyFileBlocks, claimedFiles, checkEvidence } from './files.js';
export { formatSummary } from './summary.js';

const PROMPTS = new URL('./prompts/', import.meta.url);
const loadPrompt = (n) => fs.readFileSync(new URL(`${n}.md`, PROMPTS), 'utf8');

export class UsageError extends Error {}

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
/** Commands write workers may run without a permission prompt: the usual build/test tools, the verify command, allowCommands. */
export function buildCommands(settings) {
  const verify = String(settings.verify || '').split(/&&|\|\||;|\|/).map((c) => c.trim()).filter(Boolean);
  return [...new Set([...BUILD_COMMANDS, ...verify, ...(settings.allowCommands || [])])];
}

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
  const preset = CLI_PRESETS[p.preset] || {};
  const auto = kind === 'chat' && !rest.length && p.autoFallback !== false && (!p.model || p.free)
    ? async () => (await autoFallbacks(name, p, { freeOnly: !!p.free, except: first })).filter((m) => !cooling[modelKey(name, m)] && !all.includes(m))
    // V8: an agent CLI that lists its models (agy) tries another model family after a quota hit
    : kind === 'agent' && !rest.length && p.autoFallback !== false && (p.listModels || preset.listModels)
      ? async () => (await cliFallbacks(name, { ...preset, ...p }, { except: first, defaultFamily: p.defaultFamily ?? preset.defaultFamily, run: runCmd }))
        .filter((m) => !cooling[modelKey(name, m)] && !all.includes(m))
      : null;
  return { models: all.length > 1 || auto ? left : all, auto };
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
    if (c) return { name, p, skip: `cooling down until ${untilText(c.until)} (${c.reason})` };
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

// ---------------- chat workers (H7) ----------------
const CHAT_JOB = {
  build: 'Implement the task below, and add or update tests for the behaviour you change.',
  fix: 'Fix the bug the task describes with the smallest complete change, and add or adjust a test that would have caught it.',
  test: "Write tests only: do NOT change production code. Use the project's test framework and layout. Your tests must pass on the current code and fail if the behaviour in the acceptance criteria breaks.",
  docs: 'Write or update only the documentation the task asks for. Do not change code.',
};
const CHAT_REPORT = `After the file blocks, end with this report:

## RESULT: DONE | PARTIAL | BLOCKED
## Files changed
- path — one-line summary
## Checks run
- not run (no tool access)
## Notes
- assumptions, open questions, problems you noticed`;
const CHAT_CLOSE = '\n---\nReply now, in this message: the complete <<<FILE blocks for every file the task needs, then the report. You cannot read files or run commands; everything you need is above.\n';
const CHAT_REPAIR = 'Your reply had no <<<FILE blocks, so nothing was applied. You have no tools: you cannot read files, search or run commands, and nobody will do it for you. Everything you need is in my first message. Reply now with the complete <<<FILE blocks for every file the task needs (exact format: a line "<<<FILE path", the whole file, then a line "FILE>>>"), then the report.';

// ---------------- dispatch ----------------
/**
 * Run a role with fallback.
 * opts: role, task, planPath, taskId, provider, chain, note, files, base, focus, save, noVerify, allowUnverified, allowDirty, onEvent,
 *       worktree (run in an isolated checkout on branch conductor/<id> and commit there), worktreeId, replace,
 *       continue (keep working in that task's existing worktree: a retry with a note, by the same worker by default)
 */
/**
 * Run a role with fallback, then (H2) when the winner's work fails verify, hand it once to the next provider in the
 * chain with the real error (H3), instead of the same model repairing itself. Every attempt stays in the summary.
 */
export async function dispatch(cfg, opts) {
  // H1: several attempts in parallel, the best one kept (write roles; --samples or settings.samples)
  let n = Number(opts.samples ?? cfg.settings?.samples ?? 1);
  const write = ROLES[opts.role]?.mode === 'write' && !opts.continue;
  let section = '';
  if (write && opts.planPath && opts.taskId) {
    const abs = path.resolve(cfg.root, opts.planPath);
    if (!fs.existsSync(abs)) throw new UsageError(`plan not found: ${opts.planPath}`);
    section = extractTask(fs.readFileSync(abs, 'utf8'), opts.taskId);
  }
  const files = [...(opts.files || []), ...taskFiles(section)];
  // V9 race (opt-in): --race, or settings.race for small tasks: the fastest free routes start together, the first to
  // pass every check wins and the others stop. It saves waiting, not tokens (two attempts run).
  const race = write && n <= 1 && (opts.race === true || (opts.race !== false && cfg.settings?.race === true
    && taskSize({ role: opts.role, mode: 'write', body: section || opts.task || '', files }).size === 'small'));
  if (race) n = Math.max(2, Number(cfg.settings?.raceWidth) || 2);
  if (n > 1 && write) {
    const w = await runSamples(cfg, opts, n, { dispatchOnce, chooseChain, section, body: opts.task || '', files, UsageError, race, controllerWorker: controllerWorker(cfg.controller) });
    writeJSON(path.join(cfg.root, w.runDir, 'summary.json'), w);
    return w;
  }
  const s0 = await dispatchOnce(cfg, opts);
  const s = await escalateIfNeeded(cfg, opts, s0);
  recordLessons(cfg, opts, s);
  return s;
}

/** Q7: keep what this run taught (diagnosed failures, the controller's --note) for later work in the same area. */
function recordLessons(cfg, opts, s) {
  if (cfg.settings?.lessons === false || !ROLES[opts.role] || ROLES[opts.role].mode !== 'write') return;
  try {
    let section = '';
    if (opts.planPath && opts.taskId) section = extractTask(fs.readFileSync(path.resolve(cfg.root, opts.planPath), 'utf8'), opts.taskId);
    const files = [...(opts.files || []), ...taskFiles(section)];
    if (opts.note) addLesson(cfg.root, { source: 'note', role: opts.role, files, text: opts.note.replace(/\s+/g, ' ').trim().slice(0, 300) });
    for (const l of lessonsFromRun(s, { files })) addLesson(cfg.root, l);
    // V1: the winner did this kind of work right here: its earlier failures in this area stop demoting it
    if (s.winner && outcome(s) === 'done') { const n = resolveLessons(cfg.root, { provider: s.winner, role: opts.role, files }); if (n) s.lessonsResolved = n; }
    // V1: a lesson that keeps coming back is worth a permanent rule (the user decides)
    const promo = promotable(readLessons(cfg.root)).filter((l) => lessonMatches(l, { role: opts.role, files }));
    if (promo.length) s.promotable = promo.slice(0, 3).map((l) => ({ id: l.id, count: l.count, text: l.text || GUIDANCE[l.kind] || l.kind }));
  } catch { /* lessons are a help, never a reason for a run to fail */ }
}

async function escalateIfNeeded(cfg, opts, first) {
  let s = first;
  const rounds = cfg.settings?.escalateRounds ?? 1;
  for (let round = 1; round <= rounds && shouldEscalate(s, opts, cfg.settings || {}); round++) {
    const rest = (s.chain || []).slice((s.chain || []).indexOf(s.winner) + 1);
    if (!rest.length) break;
    const prev = s;
    const note = `${opts.note ? `${opts.note}\n\n` : ''}A previous worker (${prev.winner}) did this task, and its changes are already in your working copy. They fail these checks:\n${prev.fixBrief}\nKeep what is right, fix what fails, and stay inside the task.`;
    (opts.onEvent || (() => {}))({ type: 'escalate', provider: rest[0], from: prev.winner });
    const next = await dispatchOnce(cfg, {
      ...opts, chain: rest, provider: undefined, note,
      inheritedBase: prev.base, // the starting commit's check, not the half-changed tree's
      inheritedRepro: prev.repro?.before,
      ...(prev.worktree ? { continue: true, worktreeId: prev.worktree.id } : { allowDirty: true, inherited: true }),
    });
    next.attempts = [...prev.attempts, ...next.attempts];
    next.escalated = [...(prev.escalated || []), { from: prev.winner, verify: prev.verify.status, checksFailed: prev.checks?.failed?.length || 0, check: prev.checks?.failed?.[0] || null, run: prev.runDir }];
    if (!next.winner) { // nobody could take it over: the earlier result stands, with the attempts made
      prev.attempts = next.attempts; prev.escalated = next.escalated; prev.warnings.push(`handing the failed work to ${rest.join(', ')} did not work: ${next.attempts.slice(-rest.length).map((a) => `${a.provider}(${a.reason})`).join(', ')}`);
      writeJSON(path.join(cfg.root, prev.runDir, 'summary.json'), prev);
      s = prev; break;
    }
    s = next;
  }
  return s;
}

/** Verify failed on new failures (not only ones the starting commit already had), and handing off is allowed. */
function shouldEscalate(s, opts, settings) {
  if (s.mode !== 'write' || !s.winner || !s.fixBrief) return false;
  if (settings.escalate === false || opts.noEscalate) return false;
  if (s.checks?.failed?.length) return true; // the spec itself fails: always worth handing on
  if (s.repro?.ok === false && !s.repro.waived) return true;
  if (s.verify?.status !== 'FAIL') return false;
  if (s.verify.baseFailed && !s.verify.newFailures?.length) return false;
  return true;
}

async function dispatchOnce(cfg, opts) {
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
  let body = '', planText = '', section = '', planGate = null;
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
    // Q1: a task a worker can't do well (no files, nothing checkable, no verify, too big) goes back to the controller
    if (mode === 'write') planGate = settings.planGate === false ? { status: 'off' } : opts.allowWeakPlan ? { status: 'waived' } : { status: 'pass' };
    if (mode === 'write' && settings.planGate !== false && !opts.allowWeakPlan) {
      const problems = checkTask(section, { verifyCmd: detectVerify(root, settings), maxFiles: settings.maxTaskFiles || 4 });
      if (problems.length) throw new UsageError(`${opts.taskId} isn't ready to hand to a worker:\n  - ${problems.join('\n  - ')}\nFix the task in ${opts.planPath} (conductor plan check ${opts.planPath}), or pass --allow-weak-plan`);
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
  // Q4: a fix starts from the bug. With a repro command, conductor runs it before and after; without one, the worker
  // writes a test that fails on the original code, and conductor checks that it really does
  const reproCmd = mode === 'write' ? ((section.match(/\*\*repro:\*\*\s*`([^`]+)`/i) || [])[1] || '').trim() : '';
  const wantsRegression = role === 'fix' && !reproCmd && settings.requireRepro !== false;
  if (reproCmd) body += `\n## Reproduce\nconductor runs \`${reproCmd}\`. It fails now (that is the bug) and must pass after your fix.\n`;
  else if (wantsRegression) body += '\n## Regression test first\nWrite a test that fails because of this bug, then fix the code so it passes. conductor runs your new test against the ORIGINAL code: it must fail there, or it proves nothing.\n';
  if (opts.note) body += `\n## Orchestrator note (important)\n${opts.note}\n`;
  let continueNote = '';

  // skills from the library that match this task: listed for agents (they open what they need), inlined for API models
  // Q7: what earlier work in this area taught (the controller's notes, diagnosed failures)
  const lessons = mode === 'write' && cfg.settings?.lessons !== false ? lessonsPrompt(root, { role, files: [...(opts.files || []), ...taskFiles(section)] }, { max: settings.lessonsInPrompt ?? 5 }) : { text: '', ids: [] };
  if (lessons.text) body += lessons.text;
  // Q8: the project's rules (.conductor/rules) that apply to this task's files
  const rules = mode === 'write' ? rulesPrompt(root, [...(opts.files || []), ...taskFiles(section)]) : '';
  if (rules) body += rules;
  const lessonIds = lessons.ids;
  const skillTask = { role, files: [...(opts.files || []), ...taskFiles(section)], body };
  const skillsAgent = skillsForTask(root, skillTask), skillsChat = skillsForTask(root, skillTask, { inline: true });
  let agentPrompt = `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}\n---\n# TASK (role: ${role})\n${body}${skillsAgent.text ? `\n${skillsAgent.text}` : ''}`;
  // H5: the criteria again at the very end, with how to answer them
  const criteria = mode === 'write' ? taskAcceptance(section) : [];
  const recite = acceptancePrompt(criteria);
  // H7: chat models (no tools) get their own instructions: everything inlined, no "read the files" steps, answer now.
  // Fixed text only, so providers can cache it (H8); the task goes in the user message.
  const chatSystem = mode === 'write'
    ? `${loadPrompt('_chat_worker')}\n## Your job\n${CHAT_JOB[role] || CHAT_JOB.build}\n\n${loadPrompt('_chat_write')}\n\n${CHAT_REPORT}`
    : `${loadPrompt('_worker')}\n${loadPrompt(meta.prompt)}`;
  let work = root; // where the worker runs: the repo, or its own worktree
  // V12: seconds spent in each step of this run (context, base, guard, verify, checks, repro, isolate, review)
  const timings = {};
  const timed = (k, fn) => {
    const t0 = Date.now();
    const done = () => { timings[k] = Math.round(((timings[k] || 0) + (Date.now() - t0) / 1000) * 10) / 10; };
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(done);
    done(); return r;
  };
  // Q2: facts gathered once per run (task files, callers, verify, architecture), in the form each kind of worker uses
  const packs = {};
  const packFor = (kind) => {
    if (settings.contextPack === false) return '';
    if (packs[kind] === undefined) {
      packs[kind] = timed('context', () => contextPack(work, { files: [...(opts.files || []), ...taskFiles(section)].flatMap(expandBraces), verifyCmd: detectVerify(work, verifySettings), kind, budget: settings.contextPackBytes || 4000 }));
    }
    return packs[kind];
  };
  const chatContext = () => {
    let ctx = '';
    const agents = path.join(work, 'AGENTS.md');
    if (fs.existsSync(agents)) ctx += `# AGENTS.md (project rules, authoritative)\n${fs.readFileSync(agents, 'utf8').slice(0, 20000)}\n`;
    const notes = planText && extractSection(planText, 'Design notes');
    if (notes) ctx += `\n# Design notes from ${opts.planPath}\n${notes}\n`;
    if (mode === 'write' && inRepo) {
      const map = timed('context', () => repoMap(work, { budget: settings.repoMapBytes || 6000 }));
      if (map) ctx += `\n# Project map (files, and the names each code file defines)\n${map}\n`;
    }
    const files = [...(opts.files || []), ...taskFiles(section)];
    if (files.length) ctx += `\n# Relevant files (current content)\n${readContextFiles(work, files, settings.maxContextBytes || 60000, settings.protectedPaths || [])}`;
    if (mode === 'write') ctx += packFor('chat');
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
    ...(planGate ? { planGate } : {}),
    timings, // V12: filled in as the run goes (seconds per step); workers' own time is in attempts[].seconds
  };
  let ioDir = runDir; // where CLI workers get their prompt/output files
  let wtBase = ''; // the commit a worktree started from
  let mainBefore = null;
  if (useWorktree) {
    let wt;
    try { wt = opts.continue ? openWorktree(root, wtId) : createWorktree(root, wtId || `${role}-${stamp}`, { replace: opts.replace }); } catch (e) { throw new UsageError(e.message); }
    if (!wt.continued) writeWorktreeMeta(root, wt.id, { role, plan: opts.planPath || null, task: opts.taskId || null });
    work = wt.dir;
    wtBase = wt.base;
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
  // Q7: a provider that failed this kind of work here twice goes to the back (never when the chain was given explicitly)
  if (mode === 'write' && !['chain', 'provider'].includes(picked.how) && cfg.settings?.lessons !== false) {
    const d = demoteByLessons(root, picked.chain.map((c) => c.name), { role, files: [...(opts.files || []), ...taskFiles(section)], after: settings.demoteAfter ?? 2 });
    if (d.demoted.length) { picked.chain = d.chain.map((n) => picked.chain.find((c) => c.name === n)); summary.lessonsDemoted = d.demoted; }
  }
  const chain = picked.chain;
  summary.chain = chain.filter((c) => !c.skip).map((c) => c.name);
  if (lessonIds.length) summary.lessons = lessonIds;
  if (picked.how === 'selector' && picked.note) summary.selector = picked.note;
  if (skillsAgent.names.length) summary.skills = skillsAgent.names;
  if (picked.how === 'plan' || picked.how === 'route') summary.route = picked.note;
  // H4: verify the starting commit first (cached per commit), so failures that were already there aren't blamed on
  // the worker. Before preDirty: anything the check itself leaves behind (build output) isn't credited to the worker.
  const verifyOn = mode === 'write' && inRepo && settings.autoVerify !== false && !opts.noVerify;
  const taskVerifyCmd = useWorktree ? (section.match(/\*\*verify:\*\*\s*`([^`]+)`/i) || [])[1]?.trim() : '';
  const verifySettings = taskVerifyCmd && !taskVerifyCmd.includes('<') ? { ...settings, verify: taskVerifyCmd } : settings;
  if (opts.inheritedBase) summary.base = opts.inheritedBase;
  else if (verifyOn && settings.checkBase !== false && !opts.continue && !opts.inherited) {
    emit({ type: 'base' });
    const b = await timed('base', () => baseVerify(root, work, verifySettings, path.join(runDir, 'base-verify.log')));
    if (b) {
      summary.base = { status: b.status, cmd: b.cmd, head: b.head, cached: !!b.cached, log: b.log ? rel(root, b.log) : null, failures: (b.failures || []).slice(0, 50) };
      if (b.status === 'FAIL') {
        summary.warnings.push(`verify already fails on the starting commit ${b.head} (${b.cmd}), before any worker change. Those failures are not this worker's; see ${summary.base.log}`);
        const note = `\n## Note: the project's checks already fail before your change\n\`${b.cmd}\` fails on the starting commit. Failing lines:\n\`\`\`\n${(b.failures || []).slice(0, 15).join('\n') || '(see the log)'}\n\`\`\`\nDon't fix failures unrelated to your task, and don't add new ones. In your report, say which failures were already there.\n`;
        body += note; agentPrompt += note;
      }
    }
  }
  // Q4: the repro must fail before any change, or the bug isn't reproduced and a worker can't prove a fix
  if (reproCmd) {
    if (opts.inheritedRepro) summary.repro = { cmd: reproCmd, before: opts.inheritedRepro };
    else if (!opts.continue && !opts.inherited) {
      emit({ type: 'repro' });
      const b = await timed('repro', () => runRepro(work, reproCmd, path.join(runDir, 'repro-before.log')));
      summary.repro = { cmd: reproCmd, before: b.status };
      if (b.status === 'PASS' && !opts.allowNoRepro) {
        if (useWorktree && !summary.worktree?.continued) { removeWorktree(root, summary.worktree.id, { force: true }); }
        throw new UsageError(`the repro for ${opts.taskId} already passes before any change (\`${reproCmd}\`), so it doesn't reproduce the bug. Fix the repro command in ${opts.planPath}, or pass --allow-no-repro`);
      }
    }
  }
  // files already modified before the run (allowed with --allow-dirty): can't be credited to the worker
  // (a hand-off from a previous worker in this run inherits its changes: they count as this task's work)
  const preDirty = mode === 'write' && inRepo && !opts.inherited ? new Set(git.changedFiles(work)) : new Set();
  let winnerText = '', lastPromptChars = 0;
  // hooks and .git/config can run programs: snapshot them so whatever a worker writes there is undone
  const control = inRepo ? git.snapshotControl(work) : null;
  // conductor's git-ignored files (AGENTS.md, plans, skills): git can't see a worker's edits there, so keep a copy
  const restoreLocal = snapshotLocal(root, work);
  const headBefore = inRepo ? git.head(work) : '';
  const hooksRel = inRepo ? git.repoHooksPath(work) : null;
  const protectedExtra = [...(settings.protectedPaths || []), ...(hooksRel ? [`^${hooksRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`] : [])];

  providers: for (const c of chain) {
    if (opts.signal?.aborted) { summary.cancelled = true; break; } // V9: another attempt in the race already passed
    if (c.skip) { summary.attempts.push({ provider: c.name, ok: false, reason: c.skip, skipped: true, next: nextStep(c.skip, { name: c.name, p: c.p }) }); emit({ type: 'skip', provider: c.name, reason: c.skip }); continue; }
    const kind = providerKind(c.p);
    if (mode === 'read' && kind === 'agent' && !readOnlyEnforced(c.p)) {
      summary.warnings.push(`${c.name} cannot be held to read-only (only the prompt asks it not to edit). Check git status after this run`);
    }
    // chat APIs, and agents whose read mode has no tools (goose), get the project context inlined
    const inline = kind === 'chat' || (mode === 'read' && CLI_PRESETS[c.p.preset]?.readInlineContext);
    const chatBody = body.replace('(read its Design notes)', '(its Design notes are included above)');
    // a per-provider addition (settings: providers.<name>.promptExtra), e.g. extra guidance a small model needs
    const extra = c.p.promptExtra ? `\n## Note for this model\n${c.p.promptExtra}\n` : '';
    const userPrompt = inline
      ? `${chatContext()}\n---\n# TASK (role: ${role})\n${chatBody}${skillsChat.text ? `\n${skillsChat.text}` : ''}${extra}${recite}${mode === 'write' ? CHAT_CLOSE : ''}`
      : agentPrompt + (mode === 'write' ? packFor('agent') : '') + extra + recite;
    // the provider's model, then its fallback models: a model that is rate-limited is skipped until its cooldown ends
    let { models, auto } = await modelsToTry(c.name, c.p, kind);
    let timeouts = 0;
    const resets = []; // V8: quota reset times seen on this provider's models in this run
    // its own model is cooling down, but it can list others (agy: another model family may still have quota)
    if (!models.length && auto && !getCooldowns()[c.name]) { models = await auto(); auto = null; }
    if (!models.length) {
      const reason = 'every model is cooling down';
      summary.attempts.push({ provider: c.name, ok: false, reason, skipped: true }); emit({ type: 'skip', provider: c.name, reason });
      continue;
    }
    for (let mi = 0; mi < models.length; mi++) {
      if (opts.signal?.aborted) { summary.cancelled = true; break providers; }
      const model = models[mi];
      emit({ type: 'try', provider: c.name, kind, model: mi ? model : undefined });
      const before = inRepo ? git.stateHash(work) : null;
      const t0 = Date.now();
      lastPromptChars = userPrompt.length;
      const p = model === (c.p.model || '') ? c.p : { ...c.p, model };
      let res = kind === 'chat' && !p.model
        ? { ok: false, text: '', reason: 'no model set, and its model list could not be fetched', log: '' }
        : await withSlot(c.name, c.p.maxParallel ?? CLI_PRESETS[c.p.preset]?.maxParallel, () => runProvider(c.name, p, { mode, prompt: userPrompt, system: chatSystem, cwd: work, runDir: ioDir, quotaRe,
          allowCommands: buildCommands(settings), ...limitFor(c.p, kind), signal: opts.signal }), () => emit({ type: 'wait', provider: c.name }));
      if (p !== c.p && p.model && !res.model) res.model = p.model;
      const tampered = control ? git.restoreControl(control) : [];
      const putBack = restoreLocal();
      if (putBack.length) summary.warnings.push(`${c.name} changed conductor's own files, which workers must not edit. conductor put them back: ${putBack.join(', ')}`);
      if (tampered.length) summary.warnings.push(`${c.name} changed git hooks or config, which can run programs. conductor put them back: ${tampered.join(', ')}`);
      if (headBefore && git.head(work) !== headBefore) summary.warnings.push(`${c.name} made git commits itself (HEAD moved from ${headBefore.slice(0, 8)}). Check them with git log before merging`);
      fs.writeFileSync(path.join(runDir, `${c.name}${mi ? `.${mi + 1}` : ''}.log`), res.log || '');

      // H7: a chat reply without file blocks gets one repair turn that shows the model what it said and what is needed
      if (res.ok && kind === 'chat' && mode === 'write' && !parseFileBlocks(res.text).length && settings.chatRepair !== false) {
        emit({ type: 'repair', provider: c.name });
        const again = await runProvider(c.name, p, { mode, prompt: userPrompt, system: chatSystem, cwd: work, runDir: ioDir, quotaRe, ...limitFor(c.p, kind), signal: opts.signal,
          history: [{ role: 'assistant', content: res.text.slice(0, 8000) }, { role: 'user', content: CHAT_REPAIR }] });
        const sum = (a, b) => (a || b ? { input: (a?.input || 0) + (b?.input || 0), output: (a?.output || 0) + (b?.output || 0) } : undefined);
        res = { ...(again.ok ? again : { ...res, text: res.text }), tokens: sum(res.tokens, again.tokens), log: `${res.log}\n\n==== repair turn ====\n${again.log || ''}`, repaired: true };
        fs.writeFileSync(path.join(runDir, `${c.name}${mi ? `.${mi + 1}` : ''}.log`), res.log || '');
      }
      if (res.ok && kind === 'chat' && mode === 'write') {
        const blocks = parseFileBlocks(res.text);
        const { applied, rejected } = applyFileBlocks(work, blocks, protectedExtra);
        summary.rejected.push(...rejected);
        if (!applied.length) res = { ...res, ok: false, reason: rejected.length ? 'only protected/outside files returned' : 'no file blocks in reply' };
        else summary.applied = applied;
      }
      // H6: the edit guard. Broken syntax, or a function/class the task names that still doesn't exist anywhere,
      // rejects the attempt before verify (its edits are stashed and the next provider or model runs)
      let guard = null;
      if (res.ok && mode === 'write' && inRepo) {
        const edited = git.changedFiles(work).filter((f) => !preDirty.has(f));
        const syntax = settings.syntaxCheck === false ? [] : timed('guard', () => syntaxErrors(work, edited));
        const missing = settings.contractCheck === false || !section ? [] : missingContract(work, section);
        // the export check: names the acceptance checks call, or the plan says to export, need a NAMED export (JS/TS)
        const noExport = settings.contractCheck === false || !section || !['build', 'fix'].includes(role) ? []
          : unexported(work, `${notesForFiles(extractSection(planText, 'Design notes'), taskFiles(section).flatMap(expandBraces))}\n${section}`, taskFiles(section).flatMap(expandBraces), parseChecks(criteria).map((x) => x.expr)).filter((n) => !missing.includes(n));
        if (syntax.length || missing.length || noExport.length) {
          guard = { syntax, missing, unexported: noExport };
          res = { ...res, ok: false, reason: syntax.length ? `syntax error in ${syntax.map((x) => x.file).join(', ')}`
            : missing.length ? `missing from the code: ${missing.join(', ')} (the task names ${missing.length > 1 ? 'them' : 'it'})`
              : `not exported by name: ${noExport.join(', ')} (the task needs \`export\` under exactly that name)` };
          summary.warnings.push(`${c.name}: ${syntax.length ? syntax.map((x) => `${x.file}: ${x.error}`).join('; ')
            : missing.length ? `the task names ${missing.join(', ')}, but the code doesn't define ${missing.length > 1 ? 'them' : 'it'}`
              : `${noExport.join(', ')} ${noExport.length > 1 ? 'are' : 'is'} not exported under that name (an \`export default\` or an unexported function doesn't count)`}`);
        }
      }
      const attempt = { provider: c.name, kind, ok: res.ok, reason: res.ok ? 'ok' : res.reason, seconds: Math.round((Date.now() - t0) / 100) / 10 };
      if (p.model) attempt.model = p.model;
      if (res.repaired) attempt.repaired = true;
      if (guard) attempt.guard = guard;
      if (res.tokens) { attempt.tokens = res.tokens; attempt.cost = estimateCost(c.p, res.tokens); }
      if (res.denied?.length) attempt.denied = res.denied;
      if (res.ok && res.warnings?.length) summary.warnings.push(...res.warnings);
      // a call stopped because another attempt won the race says nothing about this provider's speed or reliability
      if (res.reason !== 'cancelled') recordUsage({ provider: c.name, model: res.model || p.model || null, kind: kind === 'agent' ? 'agent' : 'chat', role, project: path.basename(root),
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
      // a free route that hung twice is cooled down, so the next call (the next task, a review) doesn't wait on it again
      if (timedOut && timeouts === 2 && kind === 'chat' && settings.hangCooldownMin !== 0) setCooldown(c.name, settings.hangCooldownMin ?? 15, 'timed out twice');
      // one more model after a timeout; a second timeout means the provider itself is hanging, so move on
      // V8: two models whose quotas reset at the same moment share one quota (the account's): stop trying models
      const accountWide = quota && res.retryAfterSec > 0 && resets.some((r) => Math.abs(r - res.retryAfterSec) <= 120);
      if (quota && res.retryAfterSec > 0) resets.push(res.retryAfterSec);
      const modelProblem = !accountWide && (quota || (kind === 'chat' && /^(timeout|empty output|server 5)/.test(res.reason || '') && timeouts < 2));
      if (modelProblem && mi === models.length - 1 && auto) { models = [...models, ...(await auto())]; auto = null; }
      const nextModel = models[mi + 1];
      const tryNext = nextModel !== undefined && modelProblem;
      if (quota) {
        const mins = res.retryAfterSec ? Math.max(1, Math.ceil(res.retryAfterSec / 60)) : (settings.cooldownMinutes || 30);
        if (models.length > 1 || mi) setCooldown(modelKey(c.name, p.model), mins, 'rate limited');
        // the provider itself cools down only when it has no other model left to try
        if (!tryNext) setCooldown(c.name, mins, accountWide ? 'quota used up for the whole account' : 'rate limited');
        attempt.reason += ` (cooldown ${mins}m)`;
      }
      attempt.next = nextStep(attempt.reason, { name: c.name, p: c.p, log: path.relative(root, path.join(runDir, `${c.name}${mi ? `.${mi + 1}` : ''}.log`)) });
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
  // V9: the race was won by another attempt while this one worked: stop here, no checks (its worktree is removed by the race)
  if (opts.signal?.aborted) {
    summary.cancelled = true;
    writeJSON(path.join(runDir, 'summary.json'), summary);
    return summary;
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
    if (criteria.length) {
      summary.acceptance = readAcceptance(winnerText, criteria);
      if (settings.requireAcceptance === false) summary.acceptance.waived = true;
    }
    // Q5: files the worker changed that the task doesn't list
    const listed = taskFiles(section).flatMap(expandBraces);
    const sc = scopeCheck(summary.changed.filter((f) => !preDirty.has(f)), listed, { allow: settings.scopeAllow || [] });
    if (sc) summary.scope = { listed, outside: sc.outside, ...(sc.outside.length && (opts.allowScope || settings.allowScope) ? { allowed: true } : {}) };
    if (settings.autoVerify !== false && !opts.noVerify) {
      emit({ type: 'verify' });
      // in a worktree, other parallel tasks' work is missing, so the task's own verify line from the plan is preferred
      summary.verify = await timed('verify', () => runVerify(work, verifySettings, path.join(runDir, 'verify.log')));
      if (verifySettings !== settings) summary.verify.scope = 'task';
      if (!useWorktree) recordVerify(root, summary.verify); // the commit guard follows the main checkout's latest verify
      if (summary.verify.status === 'FAIL' && summary.base?.status === 'FAIL') {
        summary.verify.baseFailed = true;
        let after = ''; try { after = fs.readFileSync(summary.verify.log, 'utf8'); } catch { /* no log */ }
        summary.verify.newFailures = newFailures(summary.base.failures, after).slice(0, 10);
      }
      if (summary.verify.status === 'FAIL') {
        // H3: what failed and where, written for whoever fixes it (the next worker, or the controller's --note)
        let log = ''; try { log = fs.readFileSync(summary.verify.log, 'utf8'); } catch { /* none */ }
        summary.verify.brief = failureBrief(log, fs.realpathSync(work), summary.verify.cmd);
      }
      if (summary.verify.log) summary.verify.log = rel(root, summary.verify.log);
      // H11: run the acceptance criteria themselves (`expr` returns `value`), JavaScript tasks for now
      if (criteria.length && ['build', 'fix'].includes(role) && settings.runAcceptance !== false && taskFiles(section).some((f) => /\.(m?js|cjs)$/.test(f))) {
        emit({ type: 'checks' });
        summary.checks = await timed('checks', () => runAcceptanceChecks(work, criteria, taskFiles(section).flatMap(expandBraces), { dir: runDir }));
        if (summary.checks && !summary.checks.total) summary.checks = null;
      }
      let reproBrief = '';
      if (reproCmd) {
        emit({ type: 'repro' });
        const a = await timed('repro', () => runRepro(work, reproCmd, path.join(runDir, 'repro-after.log')));
        summary.repro = { ...(summary.repro || { cmd: reproCmd }), after: a.status, ok: a.status === 'PASS' };
        if (a.status !== 'PASS') reproBrief = `The bug still reproduces: \`${reproCmd}\` still fails. Its output ends with:\n${a.tail}`;
      } else if (wantsRegression) {
        const tests = summary.changed.filter((f) => !preDirty.has(f) && TEST_FILE.test(f));
        if (!tests.length) { summary.repro = { kind: 'test', ok: false, why: 'no regression test added' }; reproBrief = 'Add a regression test: one that fails on the original code because of this bug, and passes with your fix.'; }
        else {
          emit({ type: 'repro' });
          const p = await timed('repro', () => proveRegression(root, work, useWorktree ? wtBase : headBefore, tests, verifySettings, path.join(runDir, 'repro-proof.log')));
          summary.repro = { kind: 'test', tests, proof: p.status, ok: p.status === 'proved' ? true : p.status === 'not-proved' ? false : null, ...(p.why ? { why: p.why } : {}) };
          if (p.status === 'not-proved') reproBrief = `Your new or changed tests (${tests.join(', ')}) also pass on the original, buggy code, so they don't prove the fix. Make a test fail without the fix and pass with it.`;
        }
      }
      if (summary.repro && settings.requireRepro === false) summary.repro.waived = true;
      // False alarms: correct code, but a test the worker wrote is wrong. When verify fails and every acceptance
      // check passes, run the ORIGINAL tests against only the worker's code changes. If they pass, the failures come
      // from the worker's own tests: say so, so the next worker fixes the test instead of breaking the code.
      let verifyBrief = summary.verify.status === 'FAIL' ? summary.verify.brief : '';
      // only with acceptance checks that all pass: without them, "the old tests pass" can be trivially true for wrong code
      if (verifyBrief && settings.suspectTests !== false && summary.checks?.total > 0 && !summary.checks.failed.length && !(summary.verify.baseFailed && !summary.verify.newFailures?.length)) {
        const mine = summary.changed.filter((f) => !preDirty.has(f));
        const tests = mine.filter((f) => TEST_FILE.test(f)), code = mine.filter((f) => !TEST_FILE.test(f));
        if (tests.length && code.length) {
          emit({ type: 'isolate' });
          const r = await timed('isolate', () => verifyOnBase(root, work, useWorktree ? wtBase : headBefore, code, verifySettings, path.join(runDir, 'code-only-verify.log')));
          if (r.status === 'PASS') {
            summary.verify.suspectTests = tests;
            const n = summary.checks?.total;
            verifyBrief = `Your code changes pass every test that existed before and all ${n} acceptance checks. Only tests you added or changed fail (${tests.join(', ')}):\n` +
              `${summary.verify.brief.split('\n').slice(1, -1).join('\n')}\n` +
              'These tests are probably wrong: compare each expected value with the task, its acceptance criteria and the design notes, and fix the test. Change the code only if a failing test shows a real requirement the code misses.';
          }
        }
      }
      summary.fixBrief = [verifyBrief, checksBrief(summary.checks), reproBrief].filter(Boolean).join('\n\n');
    } else {
      // skipped on purpose: the outcome is still "unverified", but it doesn't fail the run
      summary.verify = { status: 'SKIPPED', cmd: '', chosen: true, note: opts.noVerify ? 'skipped with --no-verify' : 'autoVerify is off in settings' };
    }
    // Q6: risky work that passed every check gets a second opinion from another model family (advisory)
    if (settings.autoReview !== false && !opts.noReview && outcome(summary) === 'done') {
      const base = useWorktree ? wtBase : headBefore;
      let lines = 0;
      try { lines = [...execFileSync('git', ['diff', '--numstat', base], { cwd: work }).toString().matchAll(/^(\d+)\t(\d+)\t/gm)].reduce((t, m) => t + Number(m[1]) + Number(m[2]), 0); } catch { /* none */ }
      const reasons = riskReasons({ changed: summary.changed, lines, section, settings, forced: opts.review });
      if (reasons.length) {
        emit({ type: 'review' });
        summary.review = await timed('review', () => independentReview({ work, base, worker: summary.winner, workerModel: summary.model, section, reasons,
          deps: { cfg, resolveChain, runProvider, loadPrompt, quotaRe, runDir, timeoutMs: (settings.reviewTimeoutSec || 600) * 1000 } }));
        if (summary.review?.report) summary.review.report = rel(root, summary.review.report);
      }
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
