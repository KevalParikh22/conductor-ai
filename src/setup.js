// Adding providers and first-time setup, shared by the CLI (`conductor add`, `conductor setup`, `conductor keys`)
// and the settings UI, so both behave the same.
import readline from 'node:readline';
import { CATALOG, CATEGORIES, providerFromCatalog, urlFields } from './catalog.js';
import { CLI_PRESETS, ROLES, DEFAULT_CONFIG } from './presets.js';
import { loadConfig, loadSecrets, readScope, writeScope, writeSecrets, GLOBAL_SECRETS } from './config.js';
import { keyValue, which, loadEnvFile } from './util.js';
import { listProviderModels, rankModels } from './models.js';

/** Roles a chat API is added to: the ones that don't need an agent that edits files itself. */
export const CHAT_ROLES = ['docs', 'test', 'review', 'ask'];

/** The provider name an entry lives under: an existing provider built from it (e.g. groq-api), else its id. */
export function providerNameFor(cfg, id) {
  return Object.entries(cfg.providers || {}).find(([, p]) => p.catalog === id)?.[0] || id;
}

/** Every catalog entry with its state in this config. */
export function catalogStatus(cfg) {
  return Object.entries(CATALOG).map(([id, e]) => {
    const name = providerNameFor(cfg, id);
    const p = cfg.providers[name];
    return {
      id, name, label: e.label, category: e.category, categoryLabel: CATEGORIES[e.category], about: e.about, free: e.free, privacy: e.privacy,
      keyUrl: e.keyUrl, docsUrl: e.docsUrl, apiKeyEnv: e.apiKeyEnv, apiKeyOptional: !!e.apiKeyOptional, fields: urlFields(e), model: e.model,
      keySet: !e.apiKeyEnv || !!e.apiKeyOptional || !!keyValue(e.apiKeyEnv), added: !!p, enabled: !!p?.enabled,
    };
  });
}

/**
 * Add (or re-enable) a catalog provider: save its key, fill URL fields, set the model, put it in the chat roles.
 * Writes the global config unless scope is "project". Returns what changed.
 */
export function addProvider(root, id, { key, model, baseUrl, fields = {}, scope = 'global', roles = CHAT_ROLES } = {}) {
  const e = CATALOG[id];
  if (!e) throw new Error(`unknown provider "${id}". See: conductor providers`);
  const cfg = loadConfig(root);
  const name = providerNameFor(cfg, id);
  if (key) writeSecrets({ [e.apiKeyEnv]: key });

  let url = baseUrl || e.baseUrl;
  for (const f of urlFields(e)) {
    if (!fields[f] && !baseUrl) throw new Error(`${e.label} needs ${f} (the {${f}} part of ${e.baseUrl})`);
    url = url.replace(`{${f}}`, fields[f] || '');
  }

  const data = readScope(scope, root);
  data.providers ||= {};
  const builtIn = !!DEFAULT_CONFIG.providers[name] && !data.providers[name];
  const entry = builtIn
    ? { ...(data.providers[name] || {}), ...(cfg.providers[name].enabled ? {} : { enabled: true }), ...(model ? { model } : {}), ...(url !== e.baseUrl ? { baseUrl: url } : {}) }
    : { ...providerFromCatalog(id), ...(cfg.providers[name] || {}), ...(data.providers[name] || {}), enabled: true, baseUrl: url, ...(model ? { model } : {}) };
  if (Object.keys(entry).length) data.providers[name] = entry;

  const added = [];
  data.roles ||= {};
  for (const role of roles) {
    if (!ROLES[role] || (cfg.roles[role] || []).includes(name)) continue; // only write chains that change
    data.roles[role] = [...(data.roles[role] || cfg.roles[role] || []), name];
    added.push(role);
  }
  if (!Object.keys(data.roles).length) delete data.roles;
  writeScope(scope, root, data);
  return { name, provider: loadConfig(root).providers[name], roles: added };
}

/** addProvider, then pick a model from the live list when none is set (free ones first). For the UI and --yes. */
export async function addProviderAuto(root, id, opts = {}) {
  let r = addProvider(root, id, opts);
  if (!r.provider.model) {
    const list = await listProviderModels(r.provider, { freeOnly: false });
    const m = rankModels(list.models || [])[0];
    if (m) r = { ...addProvider(root, id, { scope: opts.scope, model: m.id, roles: [] }), roles: r.roles };
    else r.warning = `no model set${list.error ? ` (could not list models: ${list.error})` : ''}: conductor will pick one when it runs, or set one on its card`;
  }
  return r;
}

// ---------------- terminal prompts (no dependencies) ----------------
export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Ask without echoing what is typed (for API keys). */
export function askSecret(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let asked = false;
  rl._writeToOutput = (s) => { if (!asked) { rl.output.write(s); asked = true; } else if (/\r|\n/.test(s)) rl.output.write('\n'); };
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

export async function confirm(question, def = true) {
  const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

/** Numbered pick from a list; returns the chosen item, or `fallback` on an empty answer. */
export async function choose(items, label, fallback) {
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. ${label(it)}`));
  const a = await ask(`Choose 1-${items.length}${fallback ? ' (Enter = first)' : ''}: `);
  if (!a) return fallback;
  const n = Number(a);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : fallback;
}

// ---------------- conductor add ----------------
/** Interactive (or --yes) add flow for the CLI. */
export async function runAdd(root, id, o = {}) {
  const e = CATALOG[id];
  if (!e) {
    const near = Object.keys(CATALOG).filter((k) => k.includes(id) || id.includes(k) || CATALOG[k].label.toLowerCase().includes(id.toLowerCase()));
    throw new Error(`unknown provider "${id}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} See: conductor providers`);
  }
  const ask_ = interactive() && !o.yes;
  loadSecrets(root);
  console.log(`\n${e.label}: ${e.about}`);
  if (e.free) console.log(`  cost:    ${e.free}`);
  if (e.privacy) console.log(`  privacy: ${e.privacy}`);
  console.log(`  guide:   docs/providers/${id}.md`);

  let key = '';
  if (e.apiKeyEnv && !keyValue(e.apiKeyEnv)) {
    if (e.apiKeyOptional) console.log(`\nNo ${e.apiKeyEnv} needed to start (it raises limits). Get one at ${e.keyUrl}`);
    else {
      console.log(`\n1. Get a key: ${e.keyUrl}`);
      if (!ask_) throw new Error(`${e.apiKeyEnv} is not set. Run in a terminal to paste it, or: conductor keys set ${e.apiKeyEnv}`);
      key = await askSecret(`2. Paste your ${e.apiKeyEnv} (hidden): `);
      if (!key) throw new Error('no key entered; nothing changed');
    }
  } else if (e.apiKeyEnv) console.log(`\n${e.apiKeyEnv} is already set.`);

  const fields = { ...(o.fields || {}) };
  for (const f of urlFields(e)) {
    if (fields[f]) continue;
    if (!ask_) throw new Error(`${e.label} needs --${f.toLowerCase().replaceAll('_', '-')} <value> (the {${f}} part of ${e.baseUrl})`);
    fields[f] = await ask(`${f.replaceAll('_', ' ').toLowerCase()} (for ${e.baseUrl}): `);
  }

  // save first so the model list and test can use the key
  let r = addProvider(root, id, { key: key || undefined, model: o.model, baseUrl: o.baseUrl, fields, scope: o.scope });
  if (!o.model && (!r.provider.model || ask_)) {
    const list = await listProviderModels(r.provider, { freeOnly: false });
    const models = rankModels(list.models || []);
    if (models.length && ask_) {
      console.log(`\n3. Pick a model (${models.length} available; coding and free ones first):`);
      const shown = models.slice(0, 25);
      const current = r.provider.model ? { id: r.provider.model } : shown[0];
      const pick = await choose(shown, (m) => `${m.id}${m.free ? '  (free)' : ''}${m.id === r.provider.model ? '  (default)' : ''}`, current);
      if (pick?.id && pick.id !== r.provider.model) r = addProvider(root, id, { model: pick.id, scope: o.scope, roles: [] });
      if (models.length > shown.length) console.log(`   (${models.length - shown.length} more: conductor models ${r.name} --all)`);
    } else if (models.length && !r.provider.model) r = addProvider(root, id, { model: models[0].id, scope: o.scope, roles: [] });
    else if (list.error) console.log(`\nCould not list models (${list.error}). Set one later: conductor ui → Providers → ${r.name}`);
  }
  return r;
}

// ---------------- conductor setup ----------------
/** What is already on this machine: agent CLIs on PATH and catalog keys in the environment. */
export function detect(cfg) {
  const agents = Object.entries(cfg.providers).filter(([, p]) => p.type === 'cli')
    .map(([name, p]) => ({ name, label: CLI_PRESETS[p.preset]?.label || name, installed: !!which({ ...(CLI_PRESETS[p.preset] || {}), ...p }.bin), enabled: !!p.enabled }));
  const keys = Object.entries(CATALOG).filter(([, e]) => e.apiKeyEnv && keyValue(e.apiKeyEnv))
    .map(([id, e]) => ({ id, name: providerNameFor(cfg, id), label: e.label, env: e.apiKeyEnv, enabled: !!cfg.providers[providerNameFor(cfg, id)]?.enabled }));
  return { agents, keys };
}

/** Enable installed agents and providers whose keys are set. Returns the names it turned on. */
export function enableDetected(root, found) {
  const on = [];
  const data = readScope('global', root);
  data.providers ||= {};
  for (const a of found.agents) if (a.installed && !a.enabled) { data.providers[a.name] = { ...(data.providers[a.name] || {}), enabled: true }; on.push(a.name); }
  if (on.length) writeScope('global', root, data);
  for (const k of found.keys) if (!k.enabled) { addProvider(root, k.id); on.push(k.name); }
  return on;
}

/** Turn on running local servers that have a chat model, using their best coding model. Returns names. */
export function enableLocal(root, local) {
  const cfg = loadConfig(root);
  const on = [];
  for (const l of local) {
    if (!l.running || !l.best) continue;
    const name = providerNameFor(cfg, l.id);
    const p = cfg.providers[name];
    if (p?.enabled && l.models.includes(p.model)) continue;
    addProvider(root, l.id, { model: p?.model && l.models.includes(p.model) ? p.model : l.best });
    on.push(`${name} (${p?.model && l.models.includes(p.model) ? p.model : l.best})`);
  }
  return on;
}

/** Keys conductor knows about, with where each comes from. Values are never returned. */
export function keyList(cfg) {
  const file = loadEnvFile(GLOBAL_SECRETS);
  const names = new Set([...Object.values(CATALOG).map((e) => e.apiKeyEnv), ...Object.values(cfg.providers).map((p) => p.apiKeyEnv)].filter(Boolean));
  return [...names].sort().map((n) => ({
    name: n, set: !!keyValue(n), placeholder: !!process.env[n] && !keyValue(n),
    source: file[n] !== undefined ? 'secrets file' : process.env[n] ? 'environment' : null,
    usedBy: Object.entries(cfg.providers).filter(([, p]) => p.apiKeyEnv === n).map(([k]) => k),
  }));
}
