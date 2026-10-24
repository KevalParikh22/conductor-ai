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
