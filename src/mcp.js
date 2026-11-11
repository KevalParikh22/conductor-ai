// Minimal MCP stdio server (no SDK). Newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.
// Speaks both the classic initialize handshake and the newer server/discover.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findProjectRoot } from './config.js';
import { dispatch, formatSummary, UsageError, parseDuration, chooseChain, extractTask, taskFiles } from './core.js';
import { compactDiff } from './diffview.js';
import { listRuns, readRun, formatRuns } from './runs.js';
import { readWorktreeMeta } from './worktree.js';
import { listSkills } from './skills.js';
import { runBatch, formatBatch } from './batch.js';
import { statusReport } from './status.js';
import { runVerify, detectVerify } from './verify.js';
import { checkPlan, formatPlanCheck } from './plancheck.js';
import { ROLES } from './presets.js';
import { VERSION } from './version.js';

const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'conductor_run',
    description: 'Delegate work to a worker LLM (Gemini, Codex, OpenCode, OpenRouter free models, ...) with automatic fallback. ' +
      'Roles: build/fix/test/docs write code (need a clean git tree on a non-main branch); review/ask are read-only. ' +
      'Returns a summary: which provider did it, its RESULT/VERDICT, changed files and the verify result. Always check `git diff` yourself before committing.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: Object.keys(ROLES), description: 'What kind of work' },
        task: { type: 'string', description: 'Task description or question (or extra instructions when plan+task_id are given)' },
        plan: { type: 'string', description: 'Path to a plan file, e.g. docs/plan/feature.md' },
        task_id: { type: 'string', description: 'Task id inside the plan, e.g. T3' },
        provider: { type: 'string', description: 'Try this provider first (e.g. antigravity-cli, codex-cli, opencode, kilo-free)' },
        note: { type: 'string', description: 'Feedback for a retry: what was wrong last time and what to do instead' },
        files: { type: 'array', items: { type: 'string' }, description: 'Extra files to include as context (used by API/chat providers)' },
        base: { type: 'string', description: 'review: git ref to diff against (default: merge-base with main)' },
        focus: { type: 'string', description: 'review: what to focus on' },
        save: { type: 'string', description: 'ask: also save the answer to this path' },
        no_verify: { type: 'boolean' },
        allow_unverified: { type: 'boolean', description: 'accept code that no verify command checked (otherwise the outcome is "unverified")' },
        allow_scope: { type: 'boolean', description: 'accept changes to files the task does not list (otherwise the outcome is "out-of-scope")' },
        allow_weak_plan: { type: 'boolean', description: 'hand out a plan task even though conductor_plan_check finds problems (no files, vague acceptance, no verify, too big)' },
        allow_open_questions: { type: 'boolean', description: 'run plan tasks even if the plan has unresolved Open questions' },
        allow_dirty: { type: 'boolean' },
        worktree: { type: 'boolean', description: 'Write roles: run in an isolated checkout on branch conductor/<task_id> and commit there, so several tasks can run at once. Merge the branch afterwards.' },
        replace: { type: 'boolean', description: 'With worktree: discard an existing worktree/branch for this task first' },
        continue: { type: 'boolean', description: 'Keep working in task_id\'s existing worktree instead of starting over: give a note with what to fix. The same worker runs unless provider is set' },
        timeout: { type: 'string', description: 'Stop a worker after this long and try the next one, e.g. "45m" or "2h"' },
      },
      required: ['role'],
    },
  },
  {
    name: 'conductor_batch',
    description: 'Run several INDEPENDENT plan tasks in parallel, each in its own git worktree on branch conductor/<id>, spread across different providers. ' +
      'Refuses tasks that depend on each other. Returns one line per task (provider, verify, commit). Review each branch with `git diff HEAD...conductor/<id>` and merge the good ones.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan file, e.g. docs/plan/feature.md' },
        tasks: { type: 'array', items: { type: 'string' }, description: 'Task ids, e.g. ["T1","T2","T3"]' },
        role: { type: 'string', description: 'Override the role for every task (default: each task\'s role in the plan)' },
        provider: { type: 'string', description: 'Try this provider first for every task (default: spread across providers)' },
        concurrency: { type: 'number', description: 'Max tasks at once (default 4)' },
        replace: { type: 'boolean' },
        no_verify: { type: 'boolean' },
        allow_weak_plan: { type: 'boolean', description: 'run tasks even though conductor_plan_check finds problems' },
        allow_open_questions: { type: 'boolean', description: 'run plan tasks even if the plan has unresolved Open questions' },
      },
      required: ['plan', 'tasks'],
    },
  },
  {
    name: 'conductor_retry',
    description: 'Have a worktree task\'s worker fix its own work in place: it continues in the existing worktree (branch conductor/<task_id>) with your note and commits the fix on the same branch. ' +
      'Use this instead of starting over when a task is close but wrong. The same worker runs unless provider is set.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task id whose worktree to continue, e.g. T3' },
        note: { type: 'string', description: 'What to fix: what was wrong and what to do instead' },
        provider: { type: 'string', description: 'Hand the fix to this provider instead of the original worker' },
        role: { type: 'string', enum: Object.keys(ROLES), description: 'Role for the retry (default: the task\'s original role)' },
        timeout: { type: 'string', description: 'Time limit, e.g. "45m"' },
      },
      required: ['task_id', 'note'],
    },
  },
  {
    name: 'conductor_diff',
    description: 'The compact diff to review: whitespace-only changes, lockfiles and build output left out, long files cut. ' +
      'No target = the working tree (new files included); a branch like conductor/T3 = that task\'s work; or a range A..B.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'Branch (conductor/T3) or range (A..B). Empty = working tree' }, lines: { type: 'number', description: 'Max lines per file (default 200)' } } },
  },
  {
    name: 'conductor_plan_check',
    description: 'Check a plan before handing out tasks: each write task needs files, acceptance criteria that can be checked, a verify command, and a size one worker can do. conductor refuses tasks that fail this.',
    inputSchema: { type: 'object', properties: { plan: { type: 'string', description: 'Plan file, e.g. docs/plan/feature.md' }, task_ids: { type: 'array', items: { type: 'string' }, description: 'Only these tasks (default: all)' } }, required: ['plan'] },
  },
  {
    name: 'conductor_route',
    description: 'Preview which providers would take a task, in what order, and why (routing rule, plan line or smart selector). Nothing runs.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description' },
        role: { type: 'string', enum: Object.keys(ROLES), description: 'Role (default build, or the plan task\'s role)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files the task touches' },
        plan: { type: 'string', description: 'Plan file (with task_id)' },
        task_id: { type: 'string', description: 'Task id inside the plan' },
      },
    },
  },
  {
    name: 'conductor_runs',
    description: 'Recent runs in this project: who did each task, the outcome (done / partial / out of scope / unverified / verify failed / failed), verify result and files. Give run to see one run in full.',
    inputSchema: { type: 'object', properties: { run: { type: 'string', description: 'A run id (or unique prefix) to show in full' }, limit: { type: 'number', description: 'How many recent runs (default 15)' } } },
  },
  { name: 'conductor_skills', description: 'The skill library for this project: each skill, whether it is on here, and which tasks it goes to. Skills reach workers automatically when they match.', inputSchema: { type: 'object', properties: {} } },
  { name: 'conductor_status', description: 'Show providers (installed / key set / cooling down), role chains, controller and repo state.', inputSchema: { type: 'object', properties: {} } },
  { name: 'conductor_verify', description: "Run the project's verify command (lint/typecheck/tests) and return the result.", inputSchema: { type: 'object', properties: {} } },
];
// every tool takes the project folder too: controllers that register conductor globally (Antigravity, Codex) may start
// it outside the project
for (const t of TOOLS) t.inputSchema.properties.project = { type: 'string', description: 'Absolute path of the project (default: the folder the MCP server started in)' };

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args, startRoot) {
  const root = args.project ? findProjectRoot(path.resolve(args.project)) : startRoot;
  const cfg = loadConfig(root);
  if (name === 'conductor_retry') {
    const m = readWorktreeMeta(root, args.task_id);
    if (!m && !args.role) return text(`conductor: no record of a worktree task "${args.task_id}". Start it with conductor_run (worktree: true) first`, true);
    args = { ...args, role: args.role || m.role, plan: m?.plan || undefined, continue: true };
    name = 'conductor_run';
  }
  if (name === 'conductor_diff') {
    const t = args.target;
    const d = compactDiff(root, { ...(t ? { range: t.includes('..') ? t : `HEAD...${t}` } : {}), maxFileLines: Number(args.lines) || 200 });
    return text(d.empty ? (t ? `no changes in ${t}` : 'no changes') : `${d.text.trimEnd()}\n\n[compact: ${d.chars.toLocaleString()} of ${d.fullChars.toLocaleString()} characters of the full diff]`);
  }
  if (name === 'conductor_plan_check') {
    const abs = path.resolve(root, args.plan || '');
    if (!args.plan || !fs.existsSync(abs)) return text(`conductor: plan not found: ${args.plan || '(none given)'}`, true);
    const rows = checkPlan(fs.readFileSync(abs, 'utf8'), { ids: args.task_ids, verifyCmd: detectVerify(root, cfg.settings), maxFiles: cfg.settings.maxTaskFiles || 4 });
    return text(rows.length ? formatPlanCheck(args.plan, rows) : `no tasks found in ${args.plan}`, !rows.length || rows.some((r) => r.problems.length));
  }
  if (name === 'conductor_route') {
    let section = '', role = args.role;
    const files = [...(args.files || [])];
    if (args.plan && args.task_id) {
      section = extractTask(fs.readFileSync(path.resolve(root, args.plan), 'utf8'), args.task_id);
      if (!section) return text(`conductor: task "${args.task_id}" not found in ${args.plan}`, true);
      role ||= (section.match(/\*\*role:\*\*\s*(\w+)/i) || [])[1];
      files.push(...taskFiles(section));
    }
    role = ROLES[role] ? role : 'build';
    const r = chooseChain(cfg, role, { section, body: args.task || '', files });
    const how = { plan: 'set by the plan', route: 'routing rule', selector: 'smart selector', role: "role's chain" }[r.how] || r.how;
    return text(`role ${role} · ${how}${r.note ? `: ${r.note}` : ''}\n${r.chain.map((c, i) => `  ${c.skip ? '-' : `${i + 1}.`} ${c.name}${c.skip ? `  (skipped: ${c.skip})` : ''}`).join('\n')}`);
  }
  if (name === 'conductor_runs') {
    if (args.run) {
      const r = readRun(root, args.run);
      if (!r) return text(`conductor: no run "${args.run}" (or the prefix matches several)`, true);
      let report = ''; try { report = r.summary.report ? fs.readFileSync(path.join(root, r.summary.report), 'utf8') : ''; } catch { /* gone */ }
      return text(`${formatSummary(r.summary)}${report ? `\n\n---- report ----\n${report.slice(-20000)}` : ''}`);
    }
    return text(formatRuns(listRuns(root, { limit: Number(args.limit) || 15 })));
  }
  if (name === 'conductor_skills') {
    const all = listSkills(root);
    if (!all.length) return text('No skills yet. Make one with: conductor skills new <name> (or the Skills page in conductor ui).');
    return text(all.map((s) => `${s.on ? '✓' : '○'} ${s.name} (${s.scope}): ${s.description}  → workers: ${['roles', 'files', 'text'].filter((k) => s.when?.[k]).map((k) => `${k} ${s.when[k]}`).join(' · ') || 'every task'}`).join('\n'));
  }
  if (name === 'conductor_status') return text(statusReport(cfg));
  if (name === 'conductor_verify') {
    const v = await runVerify(cfg.root, cfg.settings);
    return text(`verify: ${v.status}${v.cmd ? ` (${v.cmd})` : ''}\n${v.tail || v.note || ''}`, v.status === 'FAIL');
  }
  if (name === 'conductor_batch') {
    try {
      const b = await runBatch(cfg, {
        planPath: args.plan, tasks: args.tasks, role: args.role, provider: args.provider, concurrency: args.concurrency,
        replace: args.replace, noVerify: args.no_verify, allowWeakPlan: args.allow_weak_plan, allowOpenQuestions: args.allow_open_questions,
        onEvent: (e) => process.stderr.write(`[conductor ${e.task}] ${e.type} ${e.provider || ''} ${e.reason || ''}\n`),
      });
      return text(formatBatch(b), b.ok === 0);
    } catch (e) {
      return text(`conductor: ${e.message}`, true);
    }
  }
  if (name === 'conductor_run') {
    try {
      const s = await dispatch(cfg, {
        role: args.role, task: args.task, planPath: args.plan, taskId: args.task_id, provider: args.provider, note: args.note,
        files: args.files, base: args.base, focus: args.focus, save: args.save, noVerify: args.no_verify, allowUnverified: args.allow_unverified, allowScope: args.allow_scope, allowWeakPlan: args.allow_weak_plan, allowDirty: args.allow_dirty, allowOpenQuestions: args.allow_open_questions,
        worktree: args.worktree, worktreeId: args.task_id, replace: args.replace, continue: args.continue,
        timeoutMs: args.timeout ? parseDuration(args.timeout) || undefined : undefined,
        onEvent: (e) => process.stderr.write(`[conductor] ${e.type} ${e.provider || ''} ${e.reason || ''}\n`),
      });
      let out = formatSummary(s);
      if (s.report) {
        const report = fs.readFileSync(path.join(cfg.root, s.report), 'utf8');
        out += `\n\n---- worker report (${s.winner}) ----\n${report.length > 20000 ? report.slice(-20000) : report}`;
      }
      if (s.verify?.status === 'FAIL') out += `\n\n---- verify output (tail) ----\n${s.verify.tail}`;
      return text(out, !s.winner);
    } catch (e) {
      return text(`conductor: ${e.message}`, true);
    }
  }
  throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
}

export function startMcpServer({ cwd = process.cwd() } = {}) {
  const root = findProjectRoot(cwd);
  const serverInfo = { name: 'conductor-ai', version: VERSION };
  const rl = readline.createInterface({ input: process.stdin });
  process.stderr.write(`[conductor] MCP server ready (project: ${root})\n`);

  let pending = 0, closed = false;
  const maybeExit = () => { if (closed && pending === 0) process.exit(0); };
  rl.on('line', async (line) => {
    pending++;
    try { await handle(line); } finally { pending--; maybeExit(); }
  });
  rl.on('close', () => { closed = true; maybeExit(); });

  async function handle(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize': {
          const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[1];
          return reply(id, { protocolVersion: v, capabilities: { tools: {} }, serverInfo });
        }
        case 'server/discover':
          return reply(id, { resultType: 'complete', supportedVersions: SUPPORTED, capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } });
        case 'ping': return reply(id, {});
        case 'tools/list': return reply(id, { tools: TOOLS });
        case 'tools/call': return reply(id, await callTool(params.name, params.arguments || {}, root));
        default:
          if (method?.startsWith('notifications/')) return; // no reply to notifications
          if (isRequest) return fail(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      if (isRequest) fail(id, e.code || -32603, e instanceof UsageError ? e.message : String(e.message || e));
    }
  }
}
