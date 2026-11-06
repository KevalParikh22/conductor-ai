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
