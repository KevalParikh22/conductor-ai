import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG, CLI_PRESETS, ROLES } from './presets.js';
import { routeErrors } from './routing.js';
import { GLOBAL_DIR, readJSON, writeJSON, deepMerge, deepDiff, loadEnvFile, which, isPlainObject, SECRET_VARS, keyValue } from './util.js';

export const GLOBAL_CONFIG = path.join(GLOBAL_DIR, 'config.json');
export const GLOBAL_SECRETS = path.join(GLOBAL_DIR, 'secrets.env');
export const PROJECT_DIRNAME = '.conductor-ai';

// shortcut: one-time move of the pre-rename project folder .conductor; drop this once nobody has the old name
function migrateProjectDir(root) {
  const old = path.join(root, '.conductor');
  try { if (fs.existsSync(path.join(old, 'config.json')) && !fs.existsSync(path.join(root, PROJECT_DIRNAME))) fs.renameSync(old, path.join(root, PROJECT_DIRNAME)); } catch { /* keep the old folder */ }
  return root;
}

export function findProjectRoot(cwd = process.cwd()) {
  try {
    return migrateProjectDir(path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim())); // C:/x → C:\\x on Windows
  } catch {
    // not a git repo: walk up looking for .conductor-ai/
    let dir = path.resolve(cwd);
    while (true) {
      if (fs.existsSync(path.join(dir, PROJECT_DIRNAME, 'config.json')) || fs.existsSync(path.join(dir, '.conductor', 'config.json'))) return migrateProjectDir(dir);
      const up = path.dirname(dir);
      if (up === dir) return path.resolve(cwd);
      dir = up;
    }
  }
}

/** Set (string) or remove (null or "") keys in the global secrets file, mode 600. Also updates process.env. */
export function writeSecrets(updates) {
  let lines = [];
  try { lines = fs.readFileSync(GLOBAL_SECRETS, 'utf8').split('\n'); } catch { /* new file */ }
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad key name ${k}`);
    if (typeof v === 'string' && /[\r\n]/.test(v)) throw new Error('key values cannot contain newlines');
    const idx = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
    if (v === null || v === '') {
      if (idx >= 0) lines.splice(idx, 1);
      delete process.env[k];
    } else {
      const line = `${k}=${v}`;
      if (idx >= 0) lines[idx] = line; else lines.push(line);
      process.env[k] = v;
      SECRET_VARS.add(k);
    }
  }
  fs.mkdirSync(path.dirname(GLOBAL_SECRETS), { recursive: true });
  fs.writeFileSync(GLOBAL_SECRETS, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  try { fs.chmodSync(GLOBAL_SECRETS, 0o600); } catch { /* windows */ }
}

export function projectConfigPath(root) { return path.join(root, PROJECT_DIRNAME, 'config.json'); }

/** Load secrets: global secrets.env, then project .conductor-ai/.env. Real env vars always win. */
export function loadSecrets(root) {
  loadEnvFile(GLOBAL_SECRETS);
  if (root) loadEnvFile(path.join(root, PROJECT_DIRNAME, '.env'));
}

/**
 * Effective config = built-in defaults <- global config <- project config.
 * Roles are replaced whole per role; providers and settings merge per field.
 */
export function loadConfig(root = findProjectRoot()) {
  loadSecrets(root);
  const global = readJSON(GLOBAL_CONFIG, {});
  const project = readJSON(projectConfigPath(root), {});
  // a fresh copy each time: deepMerge shares what it doesn't override, so a caller changing cfg.settings or a
  // provider would otherwise change the defaults for every later load in the same process (the UI and MCP servers)
  let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), global);
  cfg = deepMerge(cfg, project);
  // routing rules add up: this project's rules first (the first match wins, so they win a conflict), then global ones
  cfg.routes = mergeRoutes(project.routes, global.routes);
  cfg.notices = dropRetired(cfg);
  cfg.root = root;
  cfg.sources = {
    global: fs.existsSync(GLOBAL_CONFIG) ? GLOBAL_CONFIG : null,
    project: fs.existsSync(projectConfigPath(root)) ? projectConfigPath(root) : null,
  };
  return cfg;
}

// CLI presets that were removed; configs saved by older versions may still name them.
const RETIRED = {
  gemini: 'Gemini CLI was removed (Google retired it for personal accounts on 18 June 2026). Use antigravity-cli instead',
};
const RETIRED_CONTROLLERS = { 'gemini-cli': 'antigravity' };

/** Remove providers built on retired presets (and their places in role chains). Returns notices. */
function dropRetired(cfg) {
  const notices = [];
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (p?.type !== 'cli' || !RETIRED[p.preset] || (p.bin && p.write)) continue;
    delete cfg.providers[name];
    for (const role of Object.keys(cfg.roles || {})) if (Array.isArray(cfg.roles[role])) cfg.roles[role] = cfg.roles[role].filter((n) => n !== name);
    notices.push(`${name}: ${RETIRED[p.preset]}. It was left out of your chains; remove it from your config to hide this message`);
  }
  if (RETIRED_CONTROLLERS[cfg.controller]) {
    notices.push(`controller "${cfg.controller}" was removed; using "${RETIRED_CONTROLLERS[cfg.controller]}". Run: conductor-ai init --controller ${RETIRED_CONTROLLERS[cfg.controller]}`);
    cfg.controller = RETIRED_CONTROLLERS[cfg.controller];
  }
  return notices;
}

const key = (r) => JSON.stringify(r);
function mergeRoutes(first = [], then = []) {
  const seen = new Set((first || []).map(key));
  return [...(first || []), ...(then || []).filter((r) => !seen.has(key(r)))];
}

// settings and roles: project over global, key by key; routing rules: both lists, the project's first
const strip = (c) => { const x = { ...c }; delete x.root; delete x.sources; delete x.notices; return x; };
/** Paths (a.b.c) set in both objects: a global change there doesn't apply in this project. */
function overlaps(changes, other, at = '') {
  const out = [];
  for (const [k, v] of Object.entries(changes || {})) {
    if (!(k in (other || {}))) continue;
    if (isPlainObject(v) && isPlainObject(other[k])) out.push(...overlaps(v, other[k], `${at}${k}.`));
    else out.push(`${at}${k}`);
  }
  return out;
}
/**
 * The UI edits the effective config (defaults + global + project). Saving writes only what was changed there into
 * the chosen file. → { data: the new file, shadowed: changed paths the project file overrides (global saves) }
 */
export function scopeSave(scope, root, eff) {
  const changes = deepDiff(strip(loadConfig(root)), strip(eff));
  const other = readScope(scope === 'global' ? 'project' : 'global', root);
  const { routes, version, ...rest } = changes;
  const data = deepMerge(readScope(scope, root), rest);
  if (routes !== undefined) {
    // rules the other file holds stay there; this file keeps the rest of the page's list
    const theirs = new Set((other.routes || []).map(key));
    data.routes = (eff.routes || []).filter((r) => !theirs.has(key(r)));
  }
  return { data: { ...data, version: 1 }, shadowed: scope === 'global' ? overlaps(rest, other) : [] };
}

export function readScope(scope, root) {
  return readJSON(scope === 'global' ? GLOBAL_CONFIG : projectConfigPath(root), {});
}

/** Write a full scope file (what the UI sends back). Strips runtime-only fields. */
export function writeScope(scope, root, data) {
  const clean = { ...data };
  delete clean.root; delete clean.sources; delete clean.notices;
  writeJSON(scope === 'global' ? GLOBAL_CONFIG : projectConfigPath(root), clean);
}

export function validateConfig(cfg) {
  const errors = [];
  if (!isPlainObject(cfg.providers)) errors.push('providers must be an object');
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (!['cli', 'openai', 'anthropic', 'manual'].includes(p.type)) errors.push(`provider ${name}: unknown type "${p.type}"`);
    if (p.type === 'cli' && !CLI_PRESETS[p.preset] && !(p.bin && p.write)) errors.push(`provider ${name}: unknown preset "${p.preset}" (or give bin + write/read args)`);
    if (p.type !== 'cli' && p.type !== 'manual' && !p.baseUrl) errors.push(`provider ${name}: baseUrl is required`);
    // never echo the value: it is often the key itself, pasted into the wrong field
    if (p.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(p.apiKeyEnv))) errors.push(`provider ${name}: "API key env var" takes the name of a variable (like KILO_API_KEY), not the key itself. Paste the key on the API keys page, or run: conductor-ai keys set <NAME>`);
    if (p.fallbackModels !== undefined && !(Array.isArray(p.fallbackModels) && p.fallbackModels.every((m) => typeof m === 'string'))) errors.push(`provider ${name}: fallbackModels must be a list of model names`);
    for (const k of ['timeoutMin', 'idleTimeoutMin']) if (p[k] !== undefined && !(Number(p[k]) > 0 || (k === 'idleTimeoutMin' && Number(p[k]) === 0))) errors.push(`provider ${name}: ${k} must be a number of minutes`);
  }
  errors.push(...routeErrors(cfg.routes, cfg.providers));
  for (const [role, chain] of Object.entries(cfg.roles || {})) {
    if (!ROLES[role]) errors.push(`unknown role "${role}"`);
    if (!Array.isArray(chain)) { errors.push(`role ${role}: chain must be a list`); continue; }
    for (const n of chain) if (!cfg.providers?.[n]) errors.push(`role ${role}: unknown provider "${n}"`);
  }
  return errors;
}

/** "local" = runs on this machine (CLI login or localhost model); "cloud" = remote API. */
export function providerLocation(p) {
  if (p.type === 'cli') return 'local-agent';
  if (p.type === 'manual') return 'manual'; // W1: you, in a web chat
  // your own say wins: e.g. a model server on another machine that you reach through localhost, or a mock in tests
  if (['local-model', 'cloud-api'].includes(p.location)) return p.location;
  try {
    const h = new URL(p.baseUrl).hostname;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || h.endsWith('.local')) return 'local-model';
  } catch { /* fall through */ }
  return 'cloud-api';
}

/** Can this provider edit files itself (agent) or only return text (chat)? */
export function providerKind(p) { return p.type === 'cli' ? 'agent' : 'chat'; }

/** What a CLI provider may do in each mode (from its preset, or its own `permissions`). */
export function providerPermissions(p) {
  if (p.type !== 'cli') return null;
  return { ...(CLI_PRESETS[p.preset]?.permissions || {}), ...(p.permissions || {}) };
}

// read-arg tokens an override may change or drop without weakening the sandbox: the prompt, model and time limit
const ADJUSTABLE = /^(\{(prompt|promptFile|outFile|ioDir|modelArgs|model|timeout|devnull)\}|\d+[smh]?)$/;

/**
 * Tokens of the preset's read args that a provider's own `read` override leaves out (flags such as --sandbox,
 * their values, {sessionSettings}). Empty when there is no override or it keeps them all.
 */
export function readOverrideMissing(p) {
  const presetRead = CLI_PRESETS[p.preset]?.read;
  if (p.type !== 'cli' || !p.read || !presetRead) return [];
  const have = new Set(p.read);
  return presetRead.filter((t) => !ADJUSTABLE.test(t) && !have.has(t));
}

/**
 * Is read-only enforced by the CLI itself (sandbox or permission rules), not just asked for in the prompt?
 * An override of the preset's read args keeps the guarantee when it still has every enforcing flag (changing
 * only the model or time limit is fine); otherwise it counts as not enforced unless it declares `permissions`.
 */
export function readOnlyEnforced(p) {
  if (p.type !== 'cli') return true; // chat APIs only return text
  if (p.read && !p.permissions && (!CLI_PRESETS[p.preset]?.read || readOverrideMissing(p).length)) return false;
  return providerPermissions(p).readOnlyEnforced === true;
}

/**
 * An API provider that is on only because it's a built-in default, and has no key yet: optional, not broken.
 * Shown as "○ add a key" by doctor, status and the UI. One you turned on yourself without a key is a problem.
 */
export function optionalNoKey(cfg, name, p = cfg.providers[name]) {
  if (!p?.enabled || p.type === 'cli' || !p.apiKeyEnv || p.apiKeyOptional || keyValue(p.apiKeyEnv) || process.env[p.apiKeyEnv]) return false;
  return ![readScope('global', cfg.root), readScope('project', cfg.root)].some((s) => s.providers?.[name]?.enabled === true);
}

/** Readiness check without making network calls. */
export function providerReadiness(name, p) {
  if (!p.enabled) return { ready: false, reason: 'disabled' };
  if (p.type === 'cli') {
    const preset = { ...(CLI_PRESETS[p.preset] || {}), ...p };
    const bin = preset.bin;
    return which(bin) ? { ready: true, reason: 'installed' } : { ready: false, reason: `"${bin}" not installed` };
  }
  if (p.type === 'manual') return { ready: true, reason: 'you paste the prompt into a web chat' };
  if (p.apiKeyEnv && !p.apiKeyOptional && !keyValue(p.apiKeyEnv)) return { ready: false, reason: `${p.apiKeyEnv} not set${process.env[p.apiKeyEnv] ? ' (placeholder value)' : ''}` };
  if (!p.model) return { ready: true, reason: 'ready (model picked automatically)' };
  return { ready: true, reason: p.apiKeyEnv && process.env[p.apiKeyEnv] ? 'key present' : 'no key needed' };
}
