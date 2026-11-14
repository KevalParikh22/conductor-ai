import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLI_PRESETS } from './presets.js';
import { run, which, GLOBAL_DIR, SECRET_VARS, keyValue } from './util.js';
import { DEFAULT_LINKS } from './worktree.js';

/**
 * Result of one provider attempt.
 * @typedef {{ok:boolean, text:string, reason?:string, retryAfterSec?:number, log:string}} Attempt
 */

function expandArgs(template, vars, modelArgs) {
  const out = [];
  for (const a of template) {
    if (a === '{modelArgs}') {
      if (vars.model) out.push(...modelArgs.map((m) => m.replaceAll('{model}', vars.model)));
      continue;
    }
    // {sessionSettings} is one whole JSON argument
    if (a === '{sessionSettings}') { out.push(vars.sessionSettings || '{}'); continue; }
    out.push(a.replaceAll('{prompt}', vars.prompt).replaceAll('{promptFile}', vars.promptFile)
      .replaceAll('{outFile}', vars.outFile).replaceAll('{ioDir}', vars.ioDir || '').replaceAll('{cwd}', vars.cwd || '')
      .replaceAll('{devnull}', os.devNull).replaceAll('{model}', vars.model || '').replaceAll('{timeout}', vars.timeout || '0'));
  }
  return out;
}

/** Fill {cwd} / {conductorHome} in every string of a settings object. */
function fillPaths(value, cwd) {
  if (typeof value === 'string') return value.replaceAll('{cwd}', cwd).replaceAll('{conductorHome}', GLOBAL_DIR);
  if (Array.isArray(value)) return value.map((v) => fillPaths(v, cwd));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [fillPaths(k, cwd), fillPaths(v, cwd)]));
  return value;
}

/**
 * Dependency folders a worktree links from the main checkout (node_modules, vendor, .venv) point outside the
 * worker's folder, and a sandbox that shows only the workspace would hide them: tests then fail with missing
 * modules. Allow reading (not writing) each such link target.
 */
export function withLinkedFolders(settings, cwd) {
  if (!settings.permissions) return settings;
  const allow = [];
  for (const name of DEFAULT_LINKS) {
    const p = path.join(cwd, name);
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
      const real = fs.realpathSync(p);
      if (real !== cwd && !real.startsWith(cwd + path.sep)) allow.push(`read_file(${real})`);
    } catch { /* missing or dangling link */ }
  }
  if (!allow.length) return settings;
  return { ...settings, permissions: { ...settings.permissions, allow: [...(settings.permissions.allow || []), ...allow] } };
}

/** Let a write worker run these commands without asking (agy `command(...)` allow rules; deny rules still win). */
export function withCommands(settings, commands) {
  if (!settings.permissions || !commands.length) return settings;
  const have = new Set(settings.permissions.allow || []);
  const add = [...new Set(commands.map((c) => c.trim()).filter(Boolean))].map((c) => `command(${c})`).filter((r) => !have.has(r));
  return { ...settings, permissions: { ...settings.permissions, allow: [...(settings.permissions.allow || []), ...add] } };
}

/**
 * Environment for a CLI worker: the user's shell environment, minus the secrets conductor loaded from
 * secrets.env / .conductor/.env (except those this CLI needs, `passEnv`), plus the mode's own variables.
 */
export function workerEnv(preset, mode, cwd) {
  const env = { ...process.env };
  const pass = new Set(preset.passEnv || []);
  for (const k of SECRET_VARS) if (!pass.has(k)) delete env[k];
  for (const [k, v] of Object.entries(fillPaths(preset.modeEnv?.[mode] || {}, cwd))) env[k] = typeof v === 'string' ? v : JSON.stringify(v);
  // PWD must match cwd: some CLIs (OpenCode) take the project folder from $PWD, not from their real working directory
  return { ...env, ...(preset.env || {}), PWD: cwd };
}

const fmtMin = (ms) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`);

// Linux caps one argv string at 128 KiB; stay well below it.
const MAX_PROMPT_ARG = 100_000;

/**
 * agy's --output-format json result → { text, status, denied, tokens }, or null when stdout isn't that JSON (an older
 * agy, or a custom args override without the flag). Its exit code and "SUCCESS" status don't show refused actions:
 * `denied_actions` does.
 */
export function parseAgyJson(stdout) {
  const line = String(stdout || '').trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let j; try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== 'object' || !('response' in j || 'status' in j)) return null;
  const u = j.usage || {};
  return {
    text: typeof j.response === 'string' ? j.response : '',
    status: j.status || '',
    denied: Array.isArray(j.denied_actions) ? j.denied_actions.map((d) => d.action || d.display_name || '?') : [],
    tokens: u.input_tokens != null ? { input: u.input_tokens, output: (u.output_tokens || 0) + (u.thinking_tokens || 0) } : undefined,
  };
}

const jsonLines = (stdout) => String(stdout || '').split('\n').flatMap((l) => {
  if (!l.trim().startsWith('{')) return [];
  try { const j = JSON.parse(l); return j && typeof j === 'object' && typeof j.type === 'string' ? [j] : []; } catch { return []; }
});

/**
 * `codex exec --json` events → { text, tokens, errors }, or null when stdout has no events (an older Codex, or
 * custom args without the flag). Usage is summed over turns; cached input is part of input_tokens.
 */
export function parseCodexJson(stdout) {
  const ev = jsonLines(stdout);
  if (!ev.length) return null;
  let input = 0, output = 0, seen = false;
  const texts = [], errors = [];
  for (const e of ev) {
    if (e.type === 'turn.completed' && e.usage) { seen = true; input += e.usage.input_tokens || 0; output += (e.usage.output_tokens || 0) + (e.usage.reasoning_output_tokens || 0); }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) texts.push(e.item.text);
    if (e.type === 'error' || e.type === 'turn.failed') errors.push(e.message || e.error?.message || 'error');
  }
  return { text: texts.join('\n\n'), tokens: seen ? { input, output } : undefined, errors };
}

/** `opencode run --format json` events → { text, sessionID, errors }, or null when stdout has no events. */
export function parseOpencodeJson(stdout) {
  const ev = jsonLines(stdout);
  if (!ev.length) return null;
  return {
    text: ev.filter((e) => e.type === 'text' && e.part?.text).map((e) => e.part.text).join('\n'),
    sessionID: ev.find((e) => e.sessionID)?.sessionID || '',
    errors: ev.filter((e) => e.type === 'error').map((e) => e.error?.message || 'error'),
  };
}

/** Token counts of an OpenCode session (from `session export`), or undefined. Cache reads/writes count as input. */
export function opencodeSessionTokens(exported) {
  const s = String(exported || '');
  let j; try { j = JSON.parse(s.slice(s.indexOf('{'))); } catch { return undefined; }
  const t = j?.info?.tokens;
  if (!t || t.input == null) return undefined;
  return { input: (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0), output: (t.output || 0) + (t.reasoning || 0) };
}

/**
 * Seconds until a rate limit resets, read from a provider's message, or 0. agy says "Resets in 118h3m13s"; others
 * say "try again in 30s", "retry after 120 seconds" or "resets in 5 minutes". Capped at 7 days.
 */
export function resetSeconds(text) {
  const t = String(text || '');
  const m = t.match(/(?:resets?|try again|retry)(?: after| in)\s+((?:\d+(?:\.\d+)?\s*(?:h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])\s*)+)/i);
  if (!m) return 0;
  let sec = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)) sec += Number(n) * { h: 3600, m: 60, s: 1 }[u.toLowerCase()];
  return Math.min(Math.round(sec), 7 * 86_400);
}

/** Run a CLI agent (antigravity, codex, opencode, kimi, claude, or a custom one). */
export async function runCli(name, p, opts) {
  const res = await runCliOnce(name, p, opts);
  if (res.reason === 'quota' && !res.retryAfterSec) { const s = resetSeconds(`${res.text}\n${res.log}`); if (s) res.retryAfterSec = s; }
  return res;
}

async function runCliOnce(name, p, { mode, prompt, cwd, timeoutMs, idleTimeoutMs = 0, runDir, quotaRe, allowCommands = [], signal }) {
  const preset = { ...(CLI_PRESETS[p.preset] || {}), ...p };
  if (!which(preset.bin)) return { ok: false, text: '', reason: 'not installed', log: '' };
  const promptFile = path.join(runDir, `${name}.prompt.md`);
  const outFile = path.join(runDir, `${name}.out.md`);
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(outFile, '');
  const template = (mode === 'write' ? preset.write : preset.read) || preset.write;
  // A prompt too long for argv is replaced by a pointer to the prompt file (inside the repo, so agents may read it).
  const promptArg = prompt.length > MAX_PROMPT_ARG
    ? `Read the file ${promptFile} and follow the instructions in it exactly. Do not modify that file.` : prompt;
  // Use the resolved path: the process runs there, and through a symlink (macOS /var -> /private/var)
  // a deny rule for the unresolved path would not match what the CLI sees.
  const realCwd = fs.realpathSync(cwd);
  const settings = preset.sessionSettings?.[mode]
    ? withCommands(withLinkedFolders(fillPaths(preset.sessionSettings[mode], realCwd), realCwd), mode === 'write' ? allowCommands : [])
    : null;
  const sessionSettings = settings ? JSON.stringify(settings) : '';
  const args = expandArgs(template, { prompt: promptArg, promptFile, outFile, ioDir: path.dirname(promptFile), cwd: realCwd, model: p.model, sessionSettings,
    timeout: timeoutMs ? `${Math.max(1, Math.round(timeoutMs / 60_000))}m` : '0' }, preset.modelArgs || []);
  const env = workerEnv(preset, mode, realCwd);
  const r = await run(preset.bin, args, { cwd, input: preset.stdin ? prompt : undefined, timeoutMs, idleTimeoutMs, env, signal });
  if (r.cancelled) return { ok: false, text: '', reason: 'cancelled', log: `$ ${preset.bin} (stopped: another attempt finished first)` };
  const log = `$ ${preset.bin} ${args.map((a) => (a.length > 80 ? JSON.stringify(a.slice(0, 77) + '...') : a)).join(' ')}\n` +
    `--- exit ${r.code}${r.timedOut ? (r.idle ? ' (stopped: no output)' : ' (stopped: time limit)') : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* none */ }
  const agy = preset.output === 'agy-json' ? parseAgyJson(r.stdout) : null;
  const extra = {};
  if (agy) {
    if (agy.tokens) extra.tokens = agy.tokens;
    if (agy.denied.length) extra.denied = agy.denied;
    const refused = `refused ${agy.denied.length} action(s) it needed (${[...new Set(agy.denied)].join(', ')}): headless mode can't ask for permission`;
    if (!agy.text.trim() && agy.denied.length && !r.timedOut) {
      return { ok: false, text: r.stderr, reason: `denied: ${[...new Set(agy.denied)].join(', ')} (add an allow rule, e.g. settings.allowCommands)`, log, ...extra };
    }
    if (agy.status && agy.status !== 'SUCCESS' && !r.timedOut) {
      return { ok: false, text: agy.text || r.stderr, reason: quotaRe.test(agy.text + r.stderr) ? 'quota' : `agy status ${agy.status}`, log, ...extra };
    }
    if (agy.denied.length) extra.warnings = [`${name} ${refused}, so it may have skipped steps such as running tests. Check its report and the verify result`];
    text = agy.text;
  }
  // Codex and OpenCode print JSON events: the answer and the token counts come from them, not raw stdout.
  const events = preset.output === 'codex-json' ? parseCodexJson(r.stdout) : preset.output === 'opencode-json' ? parseOpencodeJson(r.stdout) : null;
  if (events) {
    if (events.tokens) extra.tokens = events.tokens;
    if (events.sessionID) {
      const ex = await run(preset.bin, ['session', 'export', '--standalone', events.sessionID], { cwd, timeoutMs: 30_000, env });
      const tokens = ex.code === 0 ? opencodeSessionTokens(ex.stdout) : undefined;
      if (tokens) extra.tokens = tokens;
    }
    if (!text.trim()) text = events.text || events.errors.join('\n');
  }
  if (!text.trim() && !agy && !events) text = r.stdout; // agy's JSON wrapper is not the answer
  // exit 0 with nothing on stdout is a failure (e.g. agy auto-denying a tool in headless mode); stderr says why
  if (!text.trim() && r.code === 0 && !r.timedOut && !r.error) {
    return { ok: false, text: r.stderr, reason: `empty output${r.stderr.trim() ? ': ' + r.stderr.trim().split('\n').pop().slice(0, 160) : ''}`, log, ...extra };
  }
  if (!text.trim()) text = r.stderr;

  if (r.timedOut) return { ok: false, text, reason: r.idle ? `idle (no output for ${fmtMin(idleTimeoutMs)})` : `timeout (${fmtMin(timeoutMs)})`, log, ...extra };
  if (r.error) return { ok: false, text, reason: 'spawn error', log };
  if (r.code !== 0) {
    return { ok: false, text, reason: quotaRe.test(r.stdout + r.stderr) ? 'quota' : `exit ${r.code}`, log, ...extra };
  }
  if (text.trim().length < 20) return { ok: false, text, reason: 'empty output', log, ...extra };
  // Some CLIs exit 0 but only print a rate-limit message.
  if (text.length < 2000 && !/RESULT:|VERDICT:/.test(text) && quotaRe.test(text)) return { ok: false, text, reason: 'quota', log, ...extra };
  return { ok: true, text, log, ...extra };
}

/**
 * A readable log of a chat API call: the answer and the model's hidden reasoning in full (up to a cap), with their
 * sizes. Not the raw JSON cut at a fixed length: that once hid that a model put all its code in `reasoning`.
 */
export function chatLog(url, model, r) {
  const head = `POST ${url} model=${model}\n--- status ${r.status}${r.error ? ' ' + r.error : ''}`;
  const c = r.json?.choices?.[0];
  if (!c) return `${head}\n${(r.raw || '').slice(0, 4000)}`;
  const content = c.message?.content || '', reasoning = c.message?.reasoning || c.message?.reasoning_content || '';
  return `${head}\nmodel: ${r.json.model || '?'} · finish: ${c.finish_reason || '?'} · content ${content.length} chars · reasoning ${reasoning.length} chars · usage ${JSON.stringify(r.json.usage || {})}` +
    `\n--- content\n${content.slice(0, 20000)}${content.length > 20000 ? '\n[… cut]' : ''}` +
    (reasoning ? `\n--- reasoning\n${reasoning.slice(0, 4000)}${reasoning.length > 4000 ? '\n[… cut]' : ''}` : '');
}

async function httpJson(url, { headers, body, timeoutMs, signal }) {
  const ctrl = new AbortController();
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const call = (async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    let json; try { json = JSON.parse(raw); } catch { /* non-JSON error page */ }
    return { status: res.status, headers: res.headers, json, raw };
  })();
  // a hard deadline on top of the abort: a stalled TLS connection once held a free route for hours after its abort
  // fired (eval, 2026-11-13). The call is abandoned; its socket is closed by the abort or when the process ends.
  let hard, onAbort;
  const deadline = timeoutMs ? new Promise((resolve) => { hard = setTimeout(() => resolve({ status: 0, error: 'timeout' }), timeoutMs + 5000); }) : null;
  // V9: a race another attempt won: give up at once
  const cancel = signal ? new Promise((resolve) => { onAbort = () => { ctrl.abort(); resolve({ status: 0, error: 'cancelled' }); }; if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }) : null;
  try {
    return await Promise.race([call, deadline, cancel].filter(Boolean));
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message || e) };
  } finally { clearTimeout(t); clearTimeout(hard); signal?.removeEventListener('abort', onAbort); call.catch(() => {}); }
}

function classifyHttp(r) {
  if (r.status === 0) return { reason: r.error === 'timeout' || r.error === 'cancelled' ? r.error : `network: ${r.error}` };
  const ra = Number(r.headers?.get?.('retry-after'));
  if (r.status === 429) return { reason: 'quota', retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  if (r.status === 401 || r.status === 403) return { reason: `auth (${r.status})` };
  if (r.status === 402) return { reason: 'quota' };
  if (r.status >= 500) return { reason: `server ${r.status}` };
  return { reason: `http ${r.status}` };
}

/** Any OpenAI-compatible chat API: Gemini, OpenRouter, Kilo, OpenCode Zen, Groq, Ollama, LM Studio... */
export async function runOpenAI(name, p, { system, prompt, timeoutMs, history = [], signal }) {
  const key = keyValue(p.apiKeyEnv);
  if (p.apiKeyEnv && !key && !p.apiKeyOptional) return { ok: false, text: '', reason: `${p.apiKeyEnv} not set`, log: '' };
  const headers = { ...(p.headers || {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (p.baseUrl.includes('openrouter.ai')) headers['X-Title'] ||= 'conductor-ai'; // app name on OpenRouter dashboards
  const body = { model: p.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }, ...history] };
  if (p.maxTokens) body.max_tokens = p.maxTokens;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (Array.isArray(p.fallbackModels) && p.fallbackModels.length && p.baseUrl.includes('openrouter.ai')) body.models = [...new Set([p.model, ...p.fallbackModels])]; // OpenRouter also falls back on its side
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let r = await httpJson(url, { headers, body, timeoutMs, signal });
  // free routers (Kilo auto, OpenRouter free) now and then answer 200 with no content: ask once more
  if (r.status === 200 && !r.json?.error && !r.json?.choices?.[0]?.message?.content?.trim() && !signal?.aborted) r = await httpJson(url, { headers, body, timeoutMs, signal });
  const log = chatLog(url, p.model, r);
  const text = r.json?.choices?.[0]?.message?.content;
  const u = r.json?.usage;
  const tokens = u ? { input: u.prompt_tokens ?? u.input_tokens, output: u.completion_tokens ?? u.output_tokens } : undefined;
  if (r.status === 200 && typeof text === 'string' && text.trim()) {
    return { ok: true, text, log, model: r.json.model, tokens };
  }
  if (r.status === 200) {
    // OpenRouter sometimes returns 200 with an error object (upstream rate limit)
    const msg = JSON.stringify(r.json?.error || r.json || '').slice(0, 300);
    return { ok: false, text: msg, reason: /429|rate/i.test(msg) ? 'quota' : 'empty output', log };
  }
  return { ok: false, text: r.json?.error?.message || '', ...classifyHttp(r), log };
}

/** Anthropic Messages API (Claude as a remote worker). */
export async function runAnthropic(name, p, { system, prompt, timeoutMs, history = [], signal }) {
  const key = keyValue(p.apiKeyEnv || 'ANTHROPIC_API_KEY');
  if (!key) return { ok: false, text: '', reason: `${p.apiKeyEnv || 'ANTHROPIC_API_KEY'} not set`, log: '' };
  const url = (p.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  const r = await httpJson(url, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(p.headers || {}) },
    body: { model: p.model, max_tokens: p.maxTokens || 16000, system, messages: [{ role: 'user', content: prompt }, ...history] },
    timeoutMs, signal,
  });
  const log = `POST ${url} model=${p.model}\n--- status ${r.status}${r.error ? ' ' + r.error : ''}\n${(r.raw || '').slice(0, 4000)}`;
  const text = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const tokens = r.json?.usage ? { input: r.json.usage.input_tokens, output: r.json.usage.output_tokens } : undefined;
  if (r.status === 200 && text.trim()) return { ok: true, text, log, tokens };
  if (r.status === 529) return { ok: false, text: '', reason: 'server overloaded', log };
  return { ok: false, text: r.json?.error?.message || '', ...(r.status === 200 ? { reason: 'empty output' } : classifyHttp(r)), log };
}

/**
 * W1: the manual "provider" is you, in a web chat. Without an answer it writes the whole prompt (as a chat model would
 * get it) to manual.prompt.md and returns waiting; with an imported answer it returns that answer, so it goes through
 * every check like any worker's. Nothing is sent anywhere.
 */
export function runManual(name, p, { prompt, system, runDir, manualAnswer }) {
  if (manualAnswer != null) return { ok: true, text: String(manualAnswer), model: p.model || 'web chat', log: `(answer imported from a web chat by you: ${String(manualAnswer).length} characters)` };
  const text = `${system ? `${system}\n\n---\n\n` : ''}${prompt}`;
  const cap = Number(p.maxPromptChars) || 0;
  if (cap && text.length > cap) return { ok: false, text: '', reason: `prompt too long for ${p.label || name}: ${text.length} characters, its limit is ${cap}`, log: '' };
  const file = path.join(runDir, 'manual.prompt.md');
  fs.writeFileSync(file, text);
  return { ok: false, waiting: true, promptFile: file, text: '', reason: 'waiting for your answer', log: `(prompt written for a web chat: ${text.length} characters)` };
}

export function runProvider(name, p, opts) {
  if (p.type === 'manual') return runManual(name, p, opts);
  if (p.type === 'cli') return runCli(name, p, opts);
  if (p.type === 'anthropic') return runAnthropic(name, p, opts);
  return runOpenAI(name, p, opts);
}

/** Cheap connectivity test used by `conductor doctor --live` and the UI "Test" button. */
/**
 * V8 permission preflight for an agent: in a throwaway repo, ask it to run `npm test` (a command workers need) and
 * report the line it prints. Catches headless permission refusals (agy denied_actions) before real work does.
 */
export async function testPermissions(name, p, runDir, { allowCommands = [] } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-perm-'));
  try {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'perm-check', private: true, scripts: { test: 'node -e "console.log(\'PERM\'+\'OK-\'+(40+2))"' } }));
    const res = await runProvider(name, { ...p }, {
      mode: 'write', cwd: repo, runDir, timeoutMs: 300_000, quotaRe: /quota|rate.?limit|429/i, allowCommands: ['npm test', ...allowCommands],
      prompt: 'This is a permission check. Run the command `npm test` in this folder, then reply with the line it printed (it starts with PERMOK). Do not change any files.',
    });
    const ok = /PERMOK-42/.test(res.text || '');
    const denied = res.denied?.length ? [...new Set(res.denied)] : [];
    return { ok, denied, reason: ok ? 'can run build commands' : denied.length ? `refused: ${denied.join(', ')}` : (res.reason || 'did not run the command'), sample: (res.text || '').slice(0, 200) };
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

export async function testProvider(name, p, cwd, runDir) {
  const prompt = 'Reply with exactly the word: PONG';
  const res = await runProvider(name, { ...p }, {
    mode: 'read', prompt, system: 'You are a connectivity test. Reply with one word.', cwd, timeoutMs: 120_000, runDir,
    quotaRe: /quota|rate.?limit|429/i,
  });
  const pong = /PONG/i.test(res.text || '');
  return { ok: pong, reason: pong ? 'responded' : (res.reason || 'unexpected reply'), sample: (res.text || '').slice(0, 200) };
}
