// Minimal MCP stdio server (no SDK). Newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.
// Speaks both the classic initialize handshake and the newer server/discover.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findProjectRoot } from './config.js';
import { dispatch, formatSummary, UsageError } from './core.js';
import { runBatch, formatBatch } from './batch.js';
import { statusReport } from './status.js';
import { runVerify } from './verify.js';
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
        allow_dirty: { type: 'boolean' },
        worktree: { type: 'boolean', description: 'Write roles: run in an isolated checkout on branch conductor/<task_id> and commit there, so several tasks can run at once. Merge the branch afterwards.' },
        replace: { type: 'boolean', description: 'With worktree: discard an existing worktree/branch for this task first' },
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
      },
      required: ['plan', 'tasks'],
    },
  },
  { name: 'conductor_status', description: 'Show providers (installed / key set / cooling down), role chains, controller and repo state.', inputSchema: { type: 'object', properties: {} } },
  { name: 'conductor_verify', description: "Run the project's verify command (lint/typecheck/tests) and return the result.", inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args, root) {
  const cfg = loadConfig(root);
  if (name === 'conductor_status') return text(statusReport(cfg));
  if (name === 'conductor_verify') {
    const v = await runVerify(cfg.root, cfg.settings);
    return text(`verify: ${v.status}${v.cmd ? ` (${v.cmd})` : ''}\n${v.tail || v.note || ''}`, v.status === 'FAIL');
  }
  if (name === 'conductor_batch') {
    try {
      const b = await runBatch(cfg, {
        planPath: args.plan, tasks: args.tasks, role: args.role, provider: args.provider, concurrency: args.concurrency,
        replace: args.replace, noVerify: args.no_verify,
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
        files: args.files, base: args.base, focus: args.focus, save: args.save, noVerify: args.no_verify, allowDirty: args.allow_dirty,
        worktree: args.worktree, worktreeId: args.task_id, replace: args.replace,
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
