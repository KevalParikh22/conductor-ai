import { providerReadiness, providerLocation, providerKind } from './config.js';
import { CLI_PRESETS, CONTROLLERS } from './presets.js';
import { getCooldowns } from './core.js';
import * as git from './git.js';
import { detectVerify } from './verify.js';

/** Structured status, used by the CLI, the MCP server and the UI. */
export function statusData(cfg) {
  const cooldowns = getCooldowns();
  const providers = Object.entries(cfg.providers).map(([name, p]) => {
    const r = providerReadiness(name, p);
    const c = cooldowns[name];
    return {
      name, type: p.type, preset: p.preset, model: p.model || '', enabled: !!p.enabled,
      location: providerLocation(p), kind: providerKind(p), ready: r.ready && !c, reason: c ? `cooling down until ${new Date(c.until).toLocaleTimeString()}` : r.reason,
      label: p.type === 'cli' ? (CLI_PRESETS[p.preset]?.label || p.bin) : name, notes: p.notes || '',
    };
  });
  const inRepo = git.isRepo(cfg.root);
  return {
    root: cfg.root, controller: cfg.controller, controllerLabel: CONTROLLERS[cfg.controller]?.label || cfg.controller,
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
  L.push('', 'roles (fallback order, ✓ = ready):');
  for (const [role, chain] of Object.entries(d.roles)) {
    L.push(`  ${role.padEnd(7)} ${chain.map((n) => `${byName[n]?.ready ? '✓' : '✗'} ${n}`).join('  →  ')}`);
  }
  L.push('', 'providers:');
  for (const p of d.providers.filter((x) => x.enabled)) {
    L.push(`  ${p.ready ? '✓' : '✗'} ${p.name.padEnd(16)} ${p.location.padEnd(12)} ${(p.model || 'default').padEnd(24)} ${p.reason}`);
  }
  const off = d.providers.filter((x) => !x.enabled).map((x) => x.name);
  if (off.length) L.push(`  (disabled: ${off.join(', ')})`);
  return L.join('\n');
}
