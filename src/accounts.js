import fs from 'node:fs';
import path from 'node:path';
import { CLI_PRESETS } from './presets.js';
import { GLOBAL_DIR, readJSON, writeJSON, run } from './util.js';
import { readScope, writeScope } from './config.js';
import { getCooldowns } from './cooldowns.js';
import { UsageError } from './core.js';

export const ACCOUNT_KINDS = {
  codex: { env: (dir) => ({ CODEX_HOME: dir }), drop: ['OPENAI_API_KEY', 'CODEX_API_KEY'], prepare: (dir) => {
    const file = path.join(dir, 'config.toml');
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  }, login: ['login'], status: ['login', 'status'], statusTimeoutMs: 15000 },
  claude: { env: (dir) => ({ CLAUDE_CONFIG_DIR: dir }), drop: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], login: ['auth', 'login'], status: ['auth', 'status'] },
};

export function validLabel(label) { return typeof label === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(label); }
export function accountDir(provider, label) { return label === 'default' ? null : path.join(GLOBAL_DIR, 'accounts', provider, label); }
const keyFor = (provider, label) => `${provider}#${label}`;
const stateFile = () => path.join(GLOBAL_DIR, 'state.json');
const stateRead = () => readJSON(stateFile(), {});
function stateWrite(s) { writeJSON(stateFile(), s); }

function providerInfo(provider) {
  const p = readScope('global', null).providers?.[provider];
  if (!p) throw new UsageError(`unknown provider "${provider}"`);
  if (p.type !== 'cli' || !ACCOUNT_KINDS[p.preset]) throw new UsageError(`provider "${provider}" cannot have accounts`);
  return p;
}
function assertLabel(label) { if (!validLabel(label)) throw new UsageError('invalid account label'); }
function cfgAccounts(cfg, provider) { return cfg.providers?.[provider]?.accounts || []; }

export function listAccounts(cfg, provider) {
  return cfgAccounts(cfg, provider).map((a) => ({ label: a.label, enabled: a.enabled !== false, dir: accountDir(provider, a.label), key: keyFor(provider, a.label) }));
}
export function accountEnv(preset, account) {
  if (!account || account.label === 'default') return { set: {}, drop: [] };
  const kind = ACCOUNT_KINDS[preset];
  return kind ? { set: kind.env(account.dir), drop: [...(kind.drop || [])] } : { set: {}, drop: [] };
}
function writeAccounts(provider, accounts) {
  const cfg = readScope('global', null); cfg.providers[provider].accounts = accounts; writeScope('global', null, cfg);
}
export function addAccount(provider, label) {
  const p = providerInfo(provider); assertLabel(label);
  const cfg = readScope('global', null), entries = cfg.providers[provider].accounts || [];
  if (entries.some((a) => a.label === label)) throw new UsageError(`account "${label}" already exists`);
  const dir = accountDir(provider, label); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* platform permissions */ }
  ACCOUNT_KINDS[p.preset].prepare?.(dir);
  writeAccounts(provider, [...entries, { label }]);
}
export function renameAccount(provider, from, to) {
  const p = providerInfo(provider); assertLabel(from); assertLabel(to);
  if (from === 'default' || to === 'default') throw new UsageError('default account cannot be renamed');
  const cfg = readScope('global', null), entries = cfg.providers[provider].accounts || [];
  if (!entries.some((a) => a.label === from)) throw new UsageError(`unknown account "${from}"`);
  if (entries.some((a) => a.label === to)) throw new UsageError(`account "${to}" already exists`);
  fs.renameSync(accountDir(provider, from), accountDir(provider, to));
  writeAccounts(provider, entries.map((a) => a.label === from ? { ...a, label: to } : a));
  const s = stateRead(), oldKey = keyFor(provider, from), newKey = keyFor(provider, to);
  for (const field of ['accounts', 'cooldowns']) if (s[field]?.[oldKey]) { s[field][newKey] = s[field][oldKey]; delete s[field][oldKey]; }
  for (const k of Object.keys(s.cooldowns || {})) if (k.startsWith(`${oldKey}@`)) { s.cooldowns[k.replace(oldKey, newKey)] = s.cooldowns[k]; delete s.cooldowns[k]; }
  stateWrite(s);
}
export function removeAccount(provider, label) {
  providerInfo(provider); assertLabel(label);
  if (label === 'default') throw new UsageError('default account cannot be removed');
  const cfg = readScope('global', null), entries = cfg.providers[provider].accounts || [];
  if (!entries.some((a) => a.label === label)) throw new UsageError(`unknown account "${label}"`);
  fs.rmSync(accountDir(provider, label), { recursive: true, force: true });
  writeAccounts(provider, entries.filter((a) => a.label !== label));
  const s = stateRead(), k = keyFor(provider, label); delete (s.accounts ||= {})[k]; delete (s.cooldowns ||= {})[k];
  for (const x of Object.keys(s.cooldowns)) if (x.startsWith(`${k}@`)) delete s.cooldowns[x];
  stateWrite(s);
}
export function orderAccounts(provider, labels) {
  providerInfo(provider); const cfg = readScope('global', null), entries = cfg.providers[provider].accounts || [];
  if (!Array.isArray(labels) || labels.length !== entries.length || new Set(labels).size !== labels.length || labels.some((x) => !entries.some((a) => a.label === x))) throw new UsageError('account order must contain every account exactly once');
  writeAccounts(provider, labels.map((l) => entries.find((a) => a.label === l)));
}
function accountRecord(provider, label) {
  const kind = ACCOUNT_KINDS[providerInfo(provider).preset];
  const account = { label, dir: accountDir(provider, label) };
  return { kind, account };
}
export async function checkAccount(cfg, provider, label) {
  const { kind, account } = accountRecord(provider, label), envInfo = accountEnv(readScope('global', null).providers[provider].preset, account);
  fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 }); kind.prepare?.(account.dir);
  const r = await run(CLI_PRESETS[readScope('global', null).providers[provider].preset].bin, kind.status, { env: { ...process.env, ...Object.fromEntries(envInfo.drop.map((k) => [k, ''])), ...envInfo.set }, timeoutMs: kind.statusTimeoutMs || 15000 });
  const signedIn = r.code === 0 && !r.timedOut;
  const s = stateRead(); (s.accounts ||= {})[keyFor(provider, label)] = { signedIn, checkedAt: new Date().toISOString() }; stateWrite(s);
  return signedIn ? { signedIn } : { signedIn, reason: r.timedOut ? 'timed out' : 'status command failed' };
}
export async function loginAccount(cfg, provider, label, { device = false } = {}) {
  const { kind, account } = accountRecord(provider, label), p = readScope('global', null).providers[provider];
  fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 }); kind.prepare?.(account.dir);
  const envInfo = accountEnv(p.preset, account), args = [...kind.login, ...(device && p.preset === 'codex' ? ['--device-auth'] : [])];
  await run(CLI_PRESETS[p.preset].bin, args, { env: { ...process.env, ...Object.fromEntries(envInfo.drop.map((k) => [k, ''])), ...envInfo.set } });
  return checkAccount(cfg, provider, label);
}
export function accountStatus(cfg, provider) {
  const cooldowns = getCooldowns(), saved = stateRead().accounts || {};
  return listAccounts(cfg, provider).map((a) => {
    if (!a.enabled) return { label: a.label, enabled: false, state: 'disabled' };
    if (cooldowns[a.key]) return { label: a.label, enabled: true, state: 'cooling', until: cooldowns[a.key].until, reason: cooldowns[a.key].reason };
    if (saved[a.key]?.signedIn === false) return { label: a.label, enabled: true, state: 'needs-sign-in', reason: 'sign-in check failed' };
    return { label: a.label, enabled: true, state: saved[a.key] ? 'ready' : 'unchecked' };
  });
}
