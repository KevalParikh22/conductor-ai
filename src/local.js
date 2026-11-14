// Local models: find model servers running on this machine (Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan,
// a LiteLLM proxy), list the models they serve, and say what to do when one is installed but not running.
import { CATALOG } from './catalog.js';
import { which, keyValue } from './util.js';
import { rankModels, modelSizeB, MIN_LOCAL_MODEL_B } from './models.js';

// the command that shows a tool is installed, and how to start it / get a first model
const TOOLS = {
  ollama: { bin: 'ollama', start: 'ollama serve   (or open the Ollama app)', pull: 'ollama pull qwen3-coder' },
  lmstudio: { bin: 'lms', start: 'lms server start   (or LM Studio → Developer → Start server)', pull: 'lms get qwen3-coder' },
  llamacpp: { bin: 'llama-server', start: 'llama-server -m <model.gguf>', pull: null },
  vllm: { bin: 'vllm', start: 'vllm serve <model>', pull: null },
  localai: { bin: 'local-ai', start: 'local-ai run', pull: null },
  jan: { bin: null, start: 'Jan → Settings → Local API Server → Start', pull: null },
  litellm: { bin: 'litellm', start: 'litellm --config config.yaml', pull: null },
};

async function probe(baseUrl, apiKeyEnv, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const key = keyValue(apiKeyEnv);
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: ctrl.signal });
    if (res.status === 401 || res.status === 403) return { running: true, needsKey: true, models: [] };
    if (!res.ok) return { running: false };
    const json = await res.json().catch(() => null);
    const list = json?.data || json?.models;
    if (!Array.isArray(list)) return { running: false }; // something else answers on that port
    return { running: true, models: list.map((m) => m.id || m.name).filter(Boolean) };
  } catch {
    return { running: false };
  } finally { clearTimeout(t); }
}

/** Every known local server: running?, its models, the best one for coding, installed?, and the next step. */
export async function detectLocal({ timeoutMs = 1500, servers } = {}) {
  // servers: [{ id, baseUrl, ... }] to probe instead of the catalog's local entries (tests, custom ports)
  const list = servers || Object.keys(CATALOG).filter((id) => CATALOG[id].category === 'local').map((id) => ({ id, ...CATALOG[id] }));
  return Promise.all(list.map(async (e) => {
    const id = e.id, tool = TOOLS[id] || {};
    const p = await probe(e.baseUrl, e.apiKeyEnv, timeoutMs);
    const installed = p.running || (tool.bin ? !!which(tool.bin) : false);
    const models = p.models || [];
    const chat = rankModels(models.map((m) => ({ id: m })));
    // small models (a 2B model, say) fail or produce junk on coding tasks: list them, but don't pick them
    const tooSmall = chat.filter((m) => modelSizeB(m.id) !== null && modelSizeB(m.id) < MIN_LOCAL_MODEL_B).map((m) => m.id);
    const best = chat.find((m) => !tooSmall.includes(m.id))?.id || '';
    let next = null;
    if (p.running && p.needsKey) next = `it needs a key: conductor keys set ${e.apiKeyEnv}`;
    else if (p.running && !models.length) next = tool.pull ? `no models yet: ${tool.pull}` : 'no models loaded yet';
    else if (p.running && !best && tooSmall.length) next = `only small models (${tooSmall.map((m) => `${m}, ${modelSizeB(m)}B`).join('; ')}), too small for coding tasks (${MIN_LOCAL_MODEL_B}B+ works)${tool.pull ? `: ${tool.pull}` : ''}`;
    else if (p.running && !best) next = `only non-chat models (${models.join(', ')})${tool.pull ? `: ${tool.pull}` : ''}`;
    else if (!p.running && installed) next = `installed but not running: ${tool.start}`;
    return { id, label: e.label, baseUrl: e.baseUrl, running: p.running, installed, models, best, tooSmall, next };
  }));
}

// ---------------- V13: the context window a local server really uses ----------------
// Ollama runs a model with its own default window (4,096 tokens on 0.40, measured) unless num_ctx or
// OLLAMA_CONTEXT_LENGTH says otherwise, and its OpenAI endpoint cuts a longer prompt WITHOUT an error (measured: a
// 59,000-character prompt reached the model as 2,050 tokens, status 200). So conductor asks the server first.
const windows = new Map(); // `${origin}|${model}` → { at, value }

async function getJson(url, { method = 'GET', body, timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * → { window, trained, server, source } for a local OpenAI-compatible provider, or null when the server can't say.
 * window: tokens the model runs with now; trained: the most it supports. For Ollama a model that isn't loaded is
 * loaded first (an empty generate, kept for 10 minutes): its window is only known once loaded, and the task needs it
 * loaded anyway.
 */
export async function localWindow(p, { timeoutMs = 4000, loadTimeoutMs = 120_000 } = {}) {
  let origin; try { origin = new URL(p.baseUrl).origin; } catch { return null; }
  const key = `${origin}|${p.model}`;
  const hit = windows.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value = null;
  const version = await getJson(`${origin}/api/version`, { timeoutMs });
  if (version?.version && p.model) {
    const show = await getJson(`${origin}/api/show`, { method: 'POST', body: { model: p.model }, timeoutMs });
    const numCtx = Number((String(show?.parameters || '').match(/^num_ctx\s+(\d+)/m) || [])[1]) || 0;
    const trained = Number(Object.entries(show?.model_info || {}).find(([k]) => k.endsWith('.context_length'))?.[1]) || 0;
    const loaded = async () => (await getJson(`${origin}/api/ps`, { timeoutMs }))?.models?.find((m) => m.name === p.model || m.model === p.model);
    let ps = await loaded();
    if (!ps) { await getJson(`${origin}/api/generate`, { method: 'POST', body: { model: p.model, prompt: '', keep_alive: '10m' }, timeoutMs: loadTimeoutMs }); ps = await loaded(); }
    const win = Number(ps?.context_length) || numCtx || 0;
    if (win) value = { window: win, trained, server: `Ollama ${version.version}`, source: ps?.context_length ? 'loaded model' : 'num_ctx' };
  } else if (p.model) {
    const lm = await getJson(`${origin}/api/v0/models/${encodeURIComponent(p.model)}`, { timeoutMs });
    const win = Number(lm?.loaded_context_length) || 0;
    if (win) value = { window: win, trained: Number(lm?.max_context_length) || 0, server: 'LM Studio', source: 'loaded model' };
  }
  windows.set(key, { at: Date.now(), value });
  return value;
}

/** Rough token count for a prompt (about 3.5 characters a token for code and English; errs on the high side). */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.5);
