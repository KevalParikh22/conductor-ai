import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG, CLI_PRESETS, ROLES } from './presets.js';
import { GLOBAL_DIR, readJSON, writeJSON, deepMerge, loadEnvFile, which, isPlainObject } from './util.js';

export const GLOBAL_CONFIG = path.join(GLOBAL_DIR, 'config.json');
export const GLOBAL_SECRETS = path.join(GLOBAL_DIR, 'secrets.env');
export const PROJECT_DIRNAME = '.conductor';

export function findProjectRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // not a git repo: walk up looking for .conductor/
    let dir = path.resolve(cwd);
    while (true) {
      if (fs.existsSync(path.join(dir, PROJECT_DIRNAME, 'config.json'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) return path.resolve(cwd);
      dir = up;
    }
  }
}

export function projectConfigPath(root) { return path.join(root, PROJECT_DIRNAME, 'config.json'); }

/** Load secrets: global secrets.env, then project .conductor/.env. Real env vars always win. */
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
  let cfg = deepMerge(DEFAULT_CONFIG, global);
  cfg = deepMerge(cfg, project);
  cfg.root = root;
  cfg.sources = {
    global: fs.existsSync(GLOBAL_CONFIG) ? GLOBAL_CONFIG : null,
    project: fs.existsSync(projectConfigPath(root)) ? projectConfigPath(root) : null,
  };
  return cfg;
}

export function readScope(scope, root) {
  return readJSON(scope === 'global' ? GLOBAL_CONFIG : projectConfigPath(root), {});
}

/** Write a full scope file (what the UI sends back). Strips runtime-only fields. */
export function writeScope(scope, root, data) {
  const clean = { ...data };
  delete clean.root; delete clean.sources;
  writeJSON(scope === 'global' ? GLOBAL_CONFIG : projectConfigPath(root), clean);
}

export function validateConfig(cfg) {
  const errors = [];
  if (!isPlainObject(cfg.providers)) errors.push('providers must be an object');
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (!['cli', 'openai', 'anthropic'].includes(p.type)) errors.push(`provider ${name}: unknown type "${p.type}"`);
    if (p.type === 'cli' && !CLI_PRESETS[p.preset] && !(p.bin && p.write)) errors.push(`provider ${name}: unknown preset "${p.preset}" (or give bin + write/read args)`);
    if (p.type !== 'cli' && !p.baseUrl) errors.push(`provider ${name}: baseUrl is required`);
  }
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
  try {
    const h = new URL(p.baseUrl).hostname;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || h.endsWith('.local')) return 'local-model';
  } catch { /* fall through */ }
  return 'cloud-api';
}

/** Can this provider edit files itself (agent) or only return text (chat)? */
export function providerKind(p) { return p.type === 'cli' ? 'agent' : 'chat'; }

/** Readiness check without making network calls. */
export function providerReadiness(name, p) {
  if (!p.enabled) return { ready: false, reason: 'disabled' };
  if (p.type === 'cli') {
    const preset = { ...(CLI_PRESETS[p.preset] || {}), ...p };
    const bin = preset.bin;
    return which(bin) ? { ready: true, reason: 'installed' } : { ready: false, reason: `"${bin}" not installed` };
  }
  if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) return { ready: false, reason: `${p.apiKeyEnv} not set` };
  if (!p.model) return { ready: false, reason: 'no model set' };
  return { ready: true, reason: 'key present' };
}
