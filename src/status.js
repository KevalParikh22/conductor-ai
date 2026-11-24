import { providerReadiness, providerLocation, providerKind, optionalNoKey } from './config.js';
import { CLI_PRESETS, CONTROLLERS } from './presets.js';
import { getCooldowns } from './core.js';
import * as git from './git.js';
import { detectVerify } from './verify.js';
import { untilText } from './util.js';
import { allControllers } from './controllers.js';
import { accountStatus } from './accounts.js';

/** Structured status, used by the CLI, the MCP server and the UI. */
export function statusData(cfg) {
  const cooldowns = getCooldowns();
  const providers = Object.entries(cfg.providers).map(([name, p]) => {
    const r = providerReadiness(name, p);
    const c = cooldowns[name];
    const optional = optionalNoKey(cfg, name, p);
    return {
      optional, // on by default, no key yet: not broken
      cooling: c ? { until: c.until, reason: c.reason } : null, // paused by a rate limit: not broken either
      name, type: p.type, preset: p.preset, model: p.model || '', enabled: !!p.enabled,
      accounts: accountStatus(cfg, name),
      location: providerLocation(p), kind: providerKind(p), ready: r.ready && !c, reason: c ? `cooling down until ${untilText(c.until)} (${c.reason}): conductor-ai cooldown --clear ${name}` : optional ? `optional: add ${p.apiKeyEnv} to use it` : r.reason,
      label: p.type === 'cli' ? (CLI_PRESETS[p.preset]?.label || p.bin) : name, notes: p.notes || '',
    };
  });
  const inRepo = git.isRepo(cfg.root);
  return {
    root: cfg.root, controller: cfg.controller, controllerLabel: allControllers(cfg.root)[cfg.controller]?.label || cfg.controller,
    sources: cfg.sources, roles: cfg.roles, providers,
    repo: inRepo ? { branch: git.branch(cfg.root), dirty: git.isDirty(cfg.root), failedStashes: git.failedStashCount(cfg.root) } : null,
    verify: detectVerify(cfg.root, cfg.settings),
  };
}

export function statusReport(cfg) {
  const d = statusData(cfg);
  const byName = Object.fromEntries(d.providers.map((p) => [p.name, p]));
  const L = [];
  L.push(`project:    ${d.root}`);
  L.push(`controller: ${d.controllerLabel}`);
  L.push(`config:     global=${d.sources.global || '(defaults)'}  project=${d.sources.project || '(none)'}`);
  L.push(d.repo ? `repo:       branch ${d.repo.branch}, ${d.repo.dirty ? 'dirty' : 'clean'}${d.repo.failedStashes ? `, ${d.repo.failedStashes} failed-attempt stash(es)` : ''}` : 'repo:       (not a git repo)');
  L.push(`verify:     ${d.verify || '(none detected)'}`);
  L.push('', 'roles (fallback order, ✓ = ready, ○ = optional, add a key to use, ~ = cooling down after a rate limit):');
  const mark = (p) => (p?.ready ? '✓' : p?.optional ? '○' : p?.cooling ? '~' : '✗');
  for (const [role, chain] of Object.entries(d.roles)) {
    L.push(`  ${role.padEnd(7)} ${chain.map((n) => `${mark(byName[n])} ${n}`).join('  →  ')}`);
  }
  L.push('', 'providers:');
  for (const p of d.providers.filter((x) => x.enabled)) {
    L.push(`  ${mark(p)} ${p.name.padEnd(16)} ${p.location.padEnd(12)} ${(p.model || 'default').padEnd(24)} ${p.reason}`);
    for (const a of p.accounts) {
      const state = a.state === 'unchecked' ? 'not checked' : a.state === 'needs-sign-in' ? 'needs sign-in' : a.state === 'disabled' ? 'off' : a.state === 'cooling' ? `cooling down until ${untilText(a.until)}` : 'ready';
      L.push(`    ${p.name} [${a.label}] ${state}`);
    }
  }
  const off = d.providers.filter((x) => !x.enabled).map((x) => x.name);
  if (off.length) L.push(`  (disabled: ${off.join(', ')})`);
  return L.join('\n');
}
