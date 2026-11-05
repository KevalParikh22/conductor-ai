import fs from 'node:fs';
import path from 'node:path';
import { keyValue, GLOBAL_DIR, readJSON, writeJSON } from './util.js';
/** Free models on OpenRouter (pricing "0"). The free list changes often, so query it live. */
export async function listFreeModels({ all = false, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = process.env.OPENROUTER_API_KEY ? { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {};
    const res = await fetch('https://openrouter.ai/api/v1/models', { headers, signal: ctrl.signal });
    const json = await res.json();
    return (json.data || [])
      .filter((m) => all || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0))
      .map((m) => ({ id: m.id, name: m.name, context: m.context_length, tools: (m.supported_parameters || []).includes('tools') }))
      .sort((a, b) => (b.context || 0) - (a.context || 0));
  } catch {
    return [];
  } finally { clearTimeout(t); }
}

/** Models from any OpenAI-compatible provider's GET /models (Kilo, OpenCode Zen, Groq, Cerebras, NVIDIA, Ollama...). */
export async function listProviderModels(p, { freeOnly = false, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const key = keyValue(p.apiKeyEnv);
    const res = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}${res.status === 401 ? ` (${p.apiKeyEnv || 'API key'} missing or wrong)` : ''}`, models: [] };
    const json = await res.json();
    const isFree = (m) => /:free$|-free$|\/free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);
    const models = (json.data || json.models || [])
      .filter((m) => !freeOnly || isFree(m))
      .map((m) => ({ id: m.id || m.name, context: m.context_length, free: isFree(m) }));
    return { models };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e.cause?.code || e.message), models: [] };
  } finally { clearTimeout(t); }
}

// models that can't do a coding task: classifiers, embeddings, speech, images
const NOT_CHAT = /guard|safety|\bbge\b|moderation|embed|rerank|whisper|tts|speech|audio|transcri|image|vision-only|ocr|dall-e|flux|stable-diffusion/i;
/** Chat models ranked for coding work: coder models, then free ones, then the rest; non-chat models dropped. */
export function rankModels(models) {
  const score = (m) => (/coder|code|devstral|codestral/i.test(m.id) ? 2 : 0) + (m.free ? 1 : 0);
  return models.filter((m) => !NOT_CHAT.test(m.id)).sort((a, b) => score(b) - score(a));
}

const AUTO_CACHE = () => path.join(GLOBAL_DIR, 'models-cache.json');
const AUTO_TTL = 24 * 3600_000;

/**
 * The model to use for an API provider that has none set: the best-ranked one from its live list,
 * remembered for a day per provider and endpoint. '' when the list can't be fetched.
 */
export async function autoModel(name, p) {
  const cache = readJSON(AUTO_CACHE(), {});
  const hit = cache[name];
  if (hit && hit.baseUrl === p.baseUrl && Date.now() - hit.at < AUTO_TTL) return hit.model;
  const best = rankModels((await listProviderModels(p)).models || [])[0]?.id || '';
  if (best) { cache[name] = { baseUrl: p.baseUrl, model: best, at: Date.now() }; try { writeJSON(AUTO_CACHE(), cache); } catch { /* cache is optional */ } }
  return best;
}

/**
 * Up to `max` other models to fall back to on this provider when its model is rate-limited: the best-ranked
 * from its live list (free ones only for a free provider), remembered for a day. [] when the list can't be fetched.
 */
export async function autoFallbacks(name, p, { freeOnly = false, except = '', max = 3 } = {}) {
  const cache = readJSON(AUTO_CACHE(), {});
  const key = `${name}#fallbacks`;
  const hit = cache[key];
  let list = hit && hit.baseUrl === p.baseUrl && hit.freeOnly === freeOnly && Date.now() - hit.at < AUTO_TTL ? hit.models : null;
  if (!list) {
    list = rankModels((await listProviderModels(p, { freeOnly })).models || []).slice(0, max + 2).map((m) => m.id);
    if (list.length) { cache[key] = { baseUrl: p.baseUrl, freeOnly, models: list, at: Date.now() }; try { writeJSON(AUTO_CACHE(), cache); } catch { /* cache is optional */ } }
  }
  return list.filter((m) => m !== except).slice(0, max);
}
