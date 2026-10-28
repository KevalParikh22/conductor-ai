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
    const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : '';
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
