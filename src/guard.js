// Q8b: guard hooks (opt-in). What must always hold is enforced by code, not asked of the model:
//   - the controller's `git commit` is blocked while the last `conductor verify` in this checkout failed
//     (`conductor verify` again until it passes, or `conductor guard allow` for a deliberate exception);
//   - on Stop, Claude Code shows a reminder of conductor task branches still waiting for review.
// Formats were checked against the real tools:
//   Claude Code  .claude/settings.local.json  PreToolUse matcher "Bash": exit 2 + stderr blocks; Stop: {systemMessage}
//   Antigravity  .agents/hooks.json           named hook, PreToolUse grouped by matcher "run_command"; input
//                toolCall.args.CommandLine; output {"decision":"deny",reason} blocks. An empty answer {} DENIES in agy,
//                and "allow" auto-approves, so every other command gets "ask", which follows agy's own permission
//                rules (a hook can't loosen a deny rule either way).
// Codex hooks run only in trusted projects after approval in /hooks, so they wait until they can be tested.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { conductorGitDir } from './lessons.js';
import { listWorktrees } from './worktree.js';

const head = (root) => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const stateFile = (root) => path.join(conductorGitDir(root), 'verify-state.json');
export function readVerifyState(root) { try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return null; } }

/** Remember the latest verify result for this checkout (conductor verify, and runs in the main checkout). */
export function recordVerify(root, { status, cmd = '' }) {
  if (!['PASS', 'FAIL'].includes(status)) return;
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify({ status, cmd, head: head(root), at: new Date().toISOString() }));
}

/** A one-time exception: allow commits on the current HEAD even though verify failed. */
export function allowCommit(root) {
  const st = readVerifyState(root) || {};
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify({ ...st, allowedHead: head(root) }));
}

export const isCommit = (cmd) => /(^\s*|[;&|(]\s*)git(\s+-[\w-]+(=\S+|\s+\S+)?)*\s+commit(?=$|[\s;&|)])/.test(String(cmd || ''));

/** Why a commit must wait, or null. */
export function commitBlock(root) {
  const st = readVerifyState(root);
  if (!st || st.status !== 'FAIL') return null;
  const h = head(root);
  if (!h || st.head !== h || st.allowedHead === h) return null; // a new commit since, or allowed once
  return `conductor: the last verify failed${st.cmd ? ` (\`${st.cmd}\`)` : ''}, so this commit is blocked. Fix the failures and run \`conductor verify\` (a pass unblocks it), or run \`conductor guard allow\` to commit anyway.`;
}

/** Conductor task branches still waiting for review, for a Stop reminder; '' when there are none. */
export function stopReminder(root) {
  let wts = [];
  try { wts = listWorktrees(root).filter((w) => w.ahead > 0 || w.dirty); } catch { return ''; }
  if (!wts.length) return '';
  return `conductor: ${wts.length} task branch${wts.length > 1 ? 'es' : ''} waiting for review (${wts.slice(0, 5).map((w) => w.branch).join(', ')}). Check with conductor diff <branch>, then merge or remove them (conductor worktree rm <id>).`;
}

/** The hook entry point. → { stdout, stderr, code } for the tool that called it. */
export function runHook(kind, input, root) {
  if (kind === 'claude-pretool') {
    const cmd = input?.tool_input?.command;
    const why = isCommit(cmd) ? commitBlock(root) : null;
    return why ? { stdout: '', stderr: why, code: 2 } : { stdout: '', stderr: '', code: 0 };
  }
  if (kind === 'claude-stop') {
    const msg = input?.stop_hook_active ? '' : stopReminder(root);
    return { stdout: msg ? JSON.stringify({ systemMessage: msg }) : '', stderr: '', code: 0 };
  }
  if (kind === 'agy-pretool') {
    const cmd = input?.toolCall?.args?.CommandLine;
    const why = isCommit(cmd) ? commitBlock(root) : null;
    return { stdout: JSON.stringify(why ? { decision: 'deny', reason: why } : { decision: 'ask' }), stderr: '', code: 0 };
  }
  return { stdout: '', stderr: `conductor: unknown hook "${kind}"`, code: 1 };
}

// ---------------- install ----------------
const OURS = (h) => /\bconductor\s+hook\b/.test(h?.command || '');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export const GUARD_SUPPORTED = { 'claude-code': '.claude/settings.local.json', antigravity: '.agents/hooks.json' };

/** Turn the guards on or off for a controller. → { file, changed, unsupported? } */
export function setGuards(root, controller, on) {
  const rel = GUARD_SUPPORTED[controller];
  if (!rel) return { unsupported: true };
  const file = path.join(root, rel);
  const cur = readJson(file);
  if (fs.existsSync(file) && cur === null) throw new Error(`${rel} is not valid JSON: fix it first, conductor won't overwrite it`);
  const data = cur || {};
  const before = JSON.stringify(data);
  if (controller === 'claude-code') {
    data.hooks ||= {};
    for (const ev of ['PreToolUse', 'Stop']) {
      data.hooks[ev] = (data.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !OURS(h)) })).filter((g) => g.hooks.length);
      if (!data.hooks[ev].length) delete data.hooks[ev];
    }
    if (on) {
      (data.hooks.PreToolUse ||= []).push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'conductor hook claude-pretool' }] });
      (data.hooks.Stop ||= []).push({ hooks: [{ type: 'command', command: 'conductor hook claude-stop' }] });
    }
    if (!Object.keys(data.hooks).length) delete data.hooks;
  } else {
    delete data['conductor-guard'];
    if (on) data['conductor-guard'] = { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'conductor hook agy-pretool', timeout: 10 }] }] };
  }
  const after = JSON.stringify(data);
  if (after === before) return { file: rel, changed: false };
  if (!Object.keys(data).length) fs.rmSync(file, { force: true });
  else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }
  return { file: rel, changed: true };
}

export function guardsOn(root, controller) {
  const rel = GUARD_SUPPORTED[controller];
  if (!rel) return false;
  const d = readJson(path.join(root, rel));
  if (!d) return false;
  return controller === 'claude-code' ? JSON.stringify(d.hooks || {}).includes('conductor hook') : !!d['conductor-guard'];
}
