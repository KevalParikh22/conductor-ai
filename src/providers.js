import fs from 'node:fs';
import path from 'node:path';
import { CLI_PRESETS } from './presets.js';
import { run, which } from './util.js';

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
    out.push(a.replaceAll('{prompt}', vars.prompt).replaceAll('{promptFile}', vars.promptFile)
      .replaceAll('{outFile}', vars.outFile).replaceAll('{model}', vars.model || ''));
  }
  return out;
}

/** Run a CLI agent (gemini, codex, opencode, kimi, claude, or a custom one). */
export async function runCli(name, p, { mode, prompt, cwd, timeoutMs, runDir, quotaRe }) {
  const preset = { ...(CLI_PRESETS[p.preset] || {}), ...p };
  if (!which(preset.bin)) return { ok: false, text: '', reason: 'not installed', log: '' };
  const promptFile = path.join(runDir, `${name}.prompt.md`);
  const outFile = path.join(runDir, `${name}.out.md`);
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(outFile, '');
  const template = (mode === 'write' ? preset.write : preset.read) || preset.write;
  const args = expandArgs(template, { prompt, promptFile, outFile, model: p.model }, preset.modelArgs || []);
  const env = { ...process.env, ...(p.env || {}) };
  const r = await run(preset.bin, args, { cwd, input: preset.stdin ? prompt : undefined, timeoutMs, env });
  const log = `$ ${preset.bin} ${args.map((a) => (a.length > 80 ? JSON.stringify(a.slice(0, 77) + '...') : a)).join(' ')}\n` +
    `--- exit ${r.code}${r.timedOut ? ' (timeout)' : ''}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* none */ }
  if (!text.trim()) text = r.stdout.trim() ? r.stdout : r.stderr;

  if (r.timedOut) return { ok: false, text, reason: 'timeout', log };
  if (r.error) return { ok: false, text, reason: 'spawn error', log };
  if (r.code !== 0) {
    return { ok: false, text, reason: quotaRe.test(r.stdout + r.stderr) ? 'quota' : `exit ${r.code}`, log };
  }
  if (text.trim().length < 20) return { ok: false, text, reason: 'empty output', log };
  // Some CLIs exit 0 but only print a rate-limit message.
  if (text.length < 2000 && !/RESULT:|VERDICT:/.test(text) && quotaRe.test(text)) return { ok: false, text, reason: 'quota', log };
  return { ok: true, text, log };
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

/** Any OpenAI-compatible chat API: Gemini, OpenRouter, OpenAI, Moonshot/Kimi, DeepSeek, Groq, Ollama, LM Studio... */
export async function runOpenAI(name, p, { system, prompt, timeoutMs }) {
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : '';
  if (p.apiKeyEnv && !key) return { ok: false, text: '', reason: `${p.apiKeyEnv} not set`, log: '' };
  const headers = { ...(p.headers || {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (p.baseUrl.includes('openrouter.ai')) headers['X-Title'] ||= 'conductor-ai'; // app name on OpenRouter dashboards
  const body = { model: p.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  if (p.maxTokens) body.max_tokens = p.maxTokens;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (Array.isArray(p.fallbackModels) && p.fallbackModels.length) body.models = [p.model, ...p.fallbackModels]; // OpenRouter
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const r = await httpJson(url, { headers, body, timeoutMs });
  const log = `POST ${url} model=${p.model}\n--- status ${r.status}${r.error ? ' ' + r.error : ''}\n${(r.raw || '').slice(0, 4000)}`;
  const text = r.json?.choices?.[0]?.message?.content;
  if (r.status === 200 && typeof text === 'string' && text.trim()) {
    return { ok: true, text, log, model: r.json.model };
  }
  if (r.status === 200) {
    // OpenRouter sometimes returns 200 with an error object (upstream rate limit)
    const msg = JSON.stringify(r.json?.error || r.json || '').slice(0, 300);
    return { ok: false, text: msg, reason: /429|rate/i.test(msg) ? 'quota' : 'empty output', log };
  }
  return { ok: false, text: r.json?.error?.message || '', ...classifyHttp(r), log };
}

/** Anthropic Messages API (Claude as a remote worker). */
export async function runAnthropic(name, p, { system, prompt, timeoutMs }) {
  const key = process.env[p.apiKeyEnv || 'ANTHROPIC_API_KEY'];
  if (!key) return { ok: false, text: '', reason: `${p.apiKeyEnv || 'ANTHROPIC_API_KEY'} not set`, log: '' };
  const url = (p.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages';
  const r = await httpJson(url, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(p.headers || {}) },
    body: { model: p.model, max_tokens: p.maxTokens || 16000, system, messages: [{ role: 'user', content: prompt }] },
    timeoutMs,
  });
  const log = `POST ${url} model=${p.model}\n--- status ${r.status}${r.error ? ' ' + r.error : ''}\n${(r.raw || '').slice(0, 4000)}`;
  const text = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (r.status === 200 && text.trim()) return { ok: true, text, log };
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
