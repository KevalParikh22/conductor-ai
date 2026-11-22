// Account pool: one CLI provider (Codex, Claude Code) with several signed-in accounts. Each account is the same CLI
// pointed at its own config folder; when one account's quota runs out, the run moves on to the next (src/core.js).
// conductor-ai never reads, copies or prints what a CLI keeps in those folders: it only creates them, runs the CLI's
// own sign-in with the terminal attached, and reads the exit code of the CLI's own status command.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_PRESETS, DEFAULT_PROVIDERS } from './presets.js';
import { GLOBAL_DIR, readJSON, writeJSON, run, which } from './util.js';
import { readScope, writeScope } from './config.js';
import { getCooldowns } from './cooldowns.js';
import { UsageError } from './core.js';

/**
 * Per CLI preset: how one account is picked (env), what must not reach it (drop: an API key in the environment wins
 * over the account's login), how to prepare its folder, and the CLI's own sign-in and status commands.
 * agy has no home override (its login lives in the OS keyring), so it is not here.
 */
export const ACCOUNT_KINDS = {
  codex: {
    env: (dir) => ({ CODEX_HOME: dir }),
    drop: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    // Codex may keep its login in the OS keyring, which is shared by every CODEX_HOME: a file keeps each login apart
    prepare: (dir) => {
      const file = path.join(dir, 'config.toml');
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    },
    login: ['login'],
    deviceLogin: ['login', '--device-auth'],
    status: ['login', 'status'],
    statusTimeoutMs: 15_000,
  },
  claude: {
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
    drop: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    login: ['auth', 'login'],
    status: ['auth', 'status'],
    statusTimeoutMs: 15_000,
  },
};

const LABEL_RULE = 'a label is 1-32 characters: lowercase letters, digits, - and _, starting with a letter or digit';
export function validLabel(label) { return typeof label === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(label); }
/** The account's own folder; `default` is the user's normal login and has none. */
export function accountDir(provider, label) { return label === 'default' ? null : path.join(GLOBAL_DIR, 'accounts', provider, label); }
export const accountKey = (provider, label) => `${provider}#${label}`;

const stateFile = () => path.join(GLOBAL_DIR, 'state.json');
const readState = () => readJSON(stateFile(), {});
const writeState = (s) => writeJSON(stateFile(), s);

// Accounts are per person, so they live in the global config. A built-in provider (codex-cli) is often not written
// there at all: its preset then comes from the defaults.
function providerInfo(provider) {
  const p = { ...(DEFAULT_PROVIDERS[provider] || {}), ...(readScope('global', null).providers?.[provider] || {}) };
  if (!p.type) throw new UsageError(`unknown provider "${provider}" (accounts are for CLI providers in your global config)`);
  if (p.type !== 'cli' || !ACCOUNT_KINDS[p.preset]) throw new UsageError(`${provider} cannot have accounts: only ${Object.keys(ACCOUNT_KINDS).map((k) => `${k} CLI`).join(' and ')} providers can`);
  return p;
}
function assertLabel(label) { if (!validLabel(label)) throw new UsageError(`invalid account label "${label}": ${LABEL_RULE}`); }
function savedAccounts(provider) { return readScope('global', null).providers?.[provider]?.accounts || []; }
function writeAccounts(provider, accounts) {
  const g = readScope('global', null);
  g.providers ||= {};
  g.providers[provider] = { ...(g.providers[provider] || {}), accounts };
  writeScope('global', null, g);
}
function mustExist(entries, label) { if (!entries.some((a) => a.label === label)) throw new UsageError(`no account "${label}"`); }

/** Accounts of a provider in rotation order; [] when it has none (then it runs exactly as before). */
export function listAccounts(cfg, provider) {
  return (cfg.providers?.[provider]?.accounts || []).filter((a) => validLabel(a?.label))
    .map((a) => ({ label: a.label, enabled: a.enabled !== false, dir: accountDir(provider, a.label), key: accountKey(provider, a.label) }));
}

/** Variables to set and to remove for a run on this account; nothing for `default`. */
export function accountEnv(preset, account) {
  const kind = ACCOUNT_KINDS[preset];
  if (!kind || !account || account.label === 'default' || !account.dir) return { set: {}, drop: [] };
  return { set: kind.env(account.dir), drop: [...(kind.drop || [])] };
}
/** process.env with an account applied: removed keys are deleted, not emptied (an empty key can still win). */
export function envFor(preset, account, base = process.env) {
  const { set, drop } = accountEnv(preset, account);
  const env = { ...base };
  for (const k of drop) delete env[k];
  return { ...env, ...set };
}

function makeDir(provider, label, preset) {
  const dir = accountDir(provider, label);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows: no POSIX modes */ }
  ACCOUNT_KINDS[preset].prepare?.(dir);
  return dir;
}

/** Add an account at the end. The first one added also keeps the user's normal login as `default`, first. */
export function addAccount(provider, label) {
  const p = providerInfo(provider);
  assertLabel(label);
  const entries = savedAccounts(provider);
  if (entries.some((a) => a.label === label)) throw new UsageError(`${provider} already has an account "${label}"`);
  makeDir(provider, label, p.preset);
  const start = entries.length || label === 'default' ? entries : [{ label: 'default' }];
  writeAccounts(provider, [...start, { label }]);
}

export function renameAccount(provider, from, to) {
  providerInfo(provider);
  assertLabel(from); assertLabel(to);
  if (from === 'default' || to === 'default') throw new UsageError('the default account (your normal login) cannot be renamed');
  const entries = savedAccounts(provider);
  mustExist(entries, from);
  if (entries.some((a) => a.label === to)) throw new UsageError(`${provider} already has an account "${to}"`);
  // the folder moves as a whole: its files are never opened
  if (fs.existsSync(accountDir(provider, from))) fs.renameSync(accountDir(provider, from), accountDir(provider, to));
  writeAccounts(provider, entries.map((a) => (a.label === from ? { ...a, label: to } : a)));
  const s = readState(), oldKey = accountKey(provider, from), newKey = accountKey(provider, to);
  for (const field of ['accounts', 'cooldowns']) {
    for (const k of Object.keys(s[field] || {})) {
      if (k === oldKey || k.startsWith(`${oldKey}@`)) { s[field][newKey + k.slice(oldKey.length)] = s[field][k]; delete s[field][k]; }
    }
  }
  writeState(s);
}

/** Remove an account and delete its folder (its login). The caller asks the user first. */
export function removeAccount(provider, label) {
  providerInfo(provider);
  assertLabel(label);
  if (label === 'default') throw new UsageError('the default account (your normal login) cannot be removed: turn it off instead');
  const entries = savedAccounts(provider);
  mustExist(entries, label);
  fs.rmSync(accountDir(provider, label), { recursive: true, force: true });
  writeAccounts(provider, entries.filter((a) => a.label !== label));
  const s = readState(), key = accountKey(provider, label);
  for (const field of ['accounts', 'cooldowns']) {
    for (const k of Object.keys(s[field] || {})) if (k === key || k.startsWith(`${key}@`)) delete s[field][k];
  }
  writeState(s);
}

export function orderAccounts(provider, labels) {
  providerInfo(provider);
  const entries = savedAccounts(provider);
  const ok = Array.isArray(labels) && labels.length === entries.length && new Set(labels).size === labels.length && labels.every((l) => entries.some((a) => a.label === l));
  if (!ok) throw new UsageError(`the new order must name each of ${provider}'s accounts once: ${entries.map((a) => a.label).join(', ')}`);
  writeAccounts(provider, labels.map((l) => entries.find((a) => a.label === l)));
}

export function setAccountEnabled(provider, label, enabled) {
  providerInfo(provider);
  const entries = savedAccounts(provider);
  mustExist(entries, label);
  writeAccounts(provider, entries.map((a) => {
    if (a.label !== label) return a;
    const { enabled: _, ...rest } = a;
    return enabled ? rest : { ...rest, enabled: false };
  }));
}

/** Remember whether an account is signed in (a yes/no only). */
export function markSignedIn(key, signedIn) {
  const s = readState();
  (s.accounts ||= {})[key] = { signedIn, checkedAt: new Date().toISOString() };
  writeState(s);
}

/** Ask the CLI whether this account is signed in. Only the exit code is used; the output is discarded. */
export async function checkAccount(cfg, provider, label) {
  const p = providerInfo(provider);
  assertLabel(label);
  mustExist(savedAccounts(provider), label);
  const kind = ACCOUNT_KINDS[p.preset], bin = CLI_PRESETS[p.preset].bin;
  if (!which(bin)) return { signedIn: false, reason: `"${bin}" not installed` };
  const dir = makeDir(provider, label, p.preset);
  const r = await run(bin, kind.status, { env: envFor(p.preset, { label, dir }), timeoutMs: kind.statusTimeoutMs || 15_000 });
  const signedIn = r.code === 0 && !r.timedOut && !r.error;
  markSignedIn(accountKey(provider, label), signedIn);
  return signedIn ? { signedIn } : { signedIn, reason: r.timedOut ? 'the status check timed out' : 'not signed in' };
}

/** Run the CLI's own sign-in for this account, talking to the user directly, then check it. */
export async function loginAccount(cfg, provider, label, { device = false } = {}) {
  const p = providerInfo(provider);
  assertLabel(label);
  // the user's own login is theirs to manage: conductor-ai never signs it in or out
  if (label === 'default') throw new UsageError(`default is your normal ${CLI_PRESETS[p.preset].bin} login: conductor-ai leaves it alone (sign in with \`${CLI_PRESETS[p.preset].bin}\` yourself if you need to)`);
  mustExist(savedAccounts(provider), label);
  const kind = ACCOUNT_KINDS[p.preset], bin = CLI_PRESETS[p.preset].bin;
  if (!which(bin)) throw new UsageError(`"${bin}" is not installed`);
  const dir = makeDir(provider, label, p.preset);
  const args = device && kind.deviceLogin ? kind.deviceLogin : kind.login;
  // the terminal is attached: the sign-in prompt and its URL go straight to the user, never through conductor-ai
  spawnSync(bin, args, { stdio: 'inherit', env: envFor(p.preset, { label, dir }), shell: process.platform === 'win32' });
  return checkAccount(cfg, provider, label);
}

/** Each account's state, from config, cooldowns and the last check (no process is started). */
export function accountStatus(cfg, provider) {
  const cooldowns = getCooldowns(), saved = readState().accounts || {};
  return listAccounts(cfg, provider).map((a) => {
    const base = { label: a.label, enabled: a.enabled, key: a.key };
    if (!a.enabled) return { ...base, state: 'disabled' };
    if (cooldowns[a.key]) return { ...base, state: 'cooling', until: cooldowns[a.key].until, reason: cooldowns[a.key].reason };
    if (saved[a.key]?.signedIn === false) return { ...base, state: 'needs-sign-in', reason: `needs sign-in: conductor-ai accounts login ${provider} ${a.label}` };
    return { ...base, state: saved[a.key] ? 'ready' : 'unchecked' };
  });
}

/** Providers that have accounts, for status pages. */
export function providersWithAccounts(cfg) {
  return Object.keys(cfg.providers || {}).filter((n) => listAccounts(cfg, n).length);
}
