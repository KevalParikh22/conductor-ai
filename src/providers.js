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

/** Run a CLI agent (antigravity, codex, opencode, kimi, claude, or a custom one). */
export async function runCli(name, p, { mode, prompt, cwd, timeoutMs, idleTimeoutMs = 0, runDir, quotaRe, allowCommands = [] }) {
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
  const r = await run(preset.bin, args, { cwd, input: preset.stdin ? prompt : undefined, timeoutMs, idleTimeoutMs, env });
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
  if (!text.trim() && !agy) text = r.stdout; // agy's JSON wrapper is not the answer
  // exit 0 with nothing on stdout is a failure (e.g. agy auto-denying a tool in headless mode); stderr says why
  if (!text.trim() && r.code === 0 && !r.timedOut && !r.error) {
    return { ok: false, text: r.stderr, reason: `empty output${r.stderr.trim() ? ': ' + r.stderr.trim().split('\n').pop().slice(0, 160) : ''}`, log };
  }
  if (!text.trim()) text = r.stderr;

  if (r.timedOut) return { ok: false, text, reason: r.idle ? `idle (no output for ${fmtMin(idleTimeoutMs)})` : `timeout (${fmtMin(timeoutMs)})`, log };
  if (r.error) return { ok: false, text, reason: 'spawn error', log };
  if (r.code !== 0) {
    return { ok: false, text, reason: quotaRe.test(r.stdout + r.stderr) ? 'quota' : `exit ${r.code}`, log };
  }
  if (text.trim().length < 20) return { ok: false, text, reason: 'empty output', log };
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

async function httpJson(url, { headers, body, timeoutMs }) {
  const ctrl = new AbortController();
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    let json; try { json = JSON.parse(raw); } catch { /* non-JSON error page */ }
    return { status: res.status, headers: res.headers, json, raw };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message || e) };
  } finally { clearTimeout(t); }
}

function classifyHttp(r) {
  if (r.status === 0) return { reason: r.error === 'timeout' ? 'timeout' : `network: ${r.error}` };
  const ra = Number(r.headers?.get?.('retry-after'));
  if (r.status === 429) return { reason: 'quota', retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  if (r.status === 401 || r.status === 403) return { reason: `auth (${r.status})` };
  if (r.status === 402) return { reason: 'quota' };
  if (r.status >= 500) return { reason: `server ${r.status}` };
  return { reason: `http ${r.status}` };
}

/** Any OpenAI-compatible chat API: Gemini, OpenRouter, Kilo, OpenCode Zen, Groq, Ollama, LM Studio... */
export async function runOpenAI(name, p, { system, prompt, timeoutMs, history = [] }) {
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
  let r = await httpJson(url, { headers, body, timeoutMs });
  // free routers (Kilo auto, OpenRouter free) now and then answer 200 with no content: ask once more
  if (r.status === 200 && !r.json?.error && !r.json?.choices?.[0]?.message?.content?.trim()) r = await httpJson(url, { headers, body, timeoutMs });
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
export async function runAnthropic(name, p, { system, prompt, timeoutMs, history = [] }) {
  const key = keyValue(p.apiKeyEnv || 'ANTHROPIC_API_KEY');
  if (!key) return { ok: false, text: '', reason: `${p.apiKeyEnv || 'ANTHROPIC_API_KEY'} not set`, log: '' };
  const url = (p.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  const r = await httpJson(url, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(p.headers || {}) },
    body: { model: p.model, max_tokens: p.maxTokens || 16000, system, messages: [{ role: 'user', content: prompt }, ...history] },
    timeoutMs,
  });
  const log = `POST ${url} model=${p.model}\n--- status ${r.status}${r.error ? ' ' + r.error : ''}\n${(r.raw || '').slice(0, 4000)}`;
  const text = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const tokens = r.json?.usage ? { input: r.json.usage.input_tokens, output: r.json.usage.output_tokens } : undefined;
  if (r.status === 200 && text.trim()) return { ok: true, text, log, tokens };
  if (r.status === 529) return { ok: false, text: '', reason: 'server overloaded', log };
  return { ok: false, text: r.json?.error?.message || '', ...(r.status === 200 ? { reason: 'empty output' } : classifyHttp(r)), log };
}

export function runProvider(name, p, opts) {
  if (p.type === 'cli') return runCli(name, p, opts);
  if (p.type === 'anthropic') return runAnthropic(name, p, opts);
  return runOpenAI(name, p, opts);
}

/** Cheap connectivity test used by `conductor doctor --live` and the UI "Test" button. */
export async function testProvider(name, p, cwd, runDir) {
  const prompt = 'Reply with exactly the word: PONG';
  const res = await runProvider(name, { ...p }, {
    mode: 'read', prompt, system: 'You are a connectivity test. Reply with one word.', cwd, timeoutMs: 120_000, runDir,
    quotaRe: /quota|rate.?limit|429/i,
  });
  const pong = /PONG/i.test(res.text || '');
  return { ok: pong, reason: pong ? 'responded' : (res.reason || 'unexpected reply'), sample: (res.text || '').slice(0, 200) };
}
