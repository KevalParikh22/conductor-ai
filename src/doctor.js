// conductor doctor: what is installed, which keys are set, whether each enabled provider answers (live) and may run
// the commands workers need, config errors and the controller's files. The CLI, MCP and UI share this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, providerPermissions, readOnlyEnforced, optionalNoKey } from './config.js';
import { CLI_PRESETS, CONTROLLERS } from './presets.js';
import { testProvider, testPermissions } from './providers.js';
import { checkControllerFiles, allControllers, controllerErrors } from './controllers.js';
import { which, keyValue } from './util.js';

/** → { results: [{ name, kind, ok, status, next, permissions, readOnlyEnforced, ... }], errs, ctrlIssues, problems } */
export async function doctorData(cfg, { live = false } = {}) {
  const results = [];
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p.enabled) continue;
    const r = { name, kind: p.type === 'cli' ? 'agent' : 'chat', ok: true, status: 'ready', next: null, permissions: providerPermissions(p), readOnlyEnforced: readOnlyEnforced(p) };
    results.push(r);
    if (p.type === 'cli') {
      const preset = { ...CLI_PRESETS[p.preset], ...p };
      if (!which(preset.bin)) { Object.assign(r, { ok: false, status: 'not installed', next: `install: ${preset.install}\n    login:   ${preset.login}` }); continue; }
    } else if (p.apiKeyEnv && !p.apiKeyOptional && !keyValue(p.apiKeyEnv)) {
      const add = p.catalog ? `conductor add ${p.catalog}` : `conductor keys set ${p.apiKeyEnv}`;
      if (optionalNoKey(cfg, name, p)) Object.assign(r, { optional: true, status: `optional: add a key to use it (${add})` });
      else Object.assign(r, { ok: false, status: `${p.apiKeyEnv} not set${process.env[p.apiKeyEnv] ? ' (placeholder value)' : ''}`, next: add });
      continue;
    }
    if (live) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-doctor-'));
      const t = await testProvider(name, p, cfg.root, dir);
      fs.rmSync(dir, { recursive: true, force: true });
      Object.assign(r, { ok: t.ok, status: t.reason, sample: t.ok ? undefined : t.sample.replace(/\s+/g, ' ').slice(0, 120),
        next: t.ok ? null : p.catalog ? `see docs/providers/${p.catalog}.md → Troubleshooting` : null });
      // V8: an agent that answers may still be refused the commands workers need (headless mode can't ask)
      if (t.ok && p.type === 'cli') {
        const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-doctor-'));
        const pt = await testPermissions(name, p, pd, { allowCommands: cfg.settings.allowCommands || [] });
        fs.rmSync(pd, { recursive: true, force: true });
        r.permissionCheck = { ok: pt.ok, reason: pt.reason, denied: pt.denied };
        if (!pt.ok) Object.assign(r, { ok: false, status: `answers, but can't run build commands: ${pt.reason}`,
          next: pt.denied.length ? `add the refused command(s) to settings.allowCommands (conductor ui → Settings, or the file from conductor config path), then conductor doctor --live` : `read what it said and check its permission settings (conductor doctor --details): ${pt.sample.replace(/\s+/g, ' ').slice(0, 100)}` });
        else r.status = `${t.reason}; ${pt.reason}`;
      }
    }
  }
  const errs = validateConfig(cfg);
  const ctrlIssues = checkControllerFiles(cfg.root, cfg.controller || 'claude-code');
  // V6: your own controller entries must name formats conductor can write
  for (const [n, c] of Object.entries(allControllers(cfg.root))) {
    if (CONTROLLERS[n]) continue;
    for (const e of controllerErrors(n, c)) ctrlIssues.push({ level: 'error', file: `controllers.${n}`, problem: e, fix: 'conductor controller check, then fix the entry in your config' });
  }
  if (!allControllers(cfg.root)[cfg.controller || 'claude-code']) ctrlIssues.push({ level: 'error', file: 'controller', problem: `unknown controller "${cfg.controller}"`, fix: 'conductor controller list, then conductor init --controller <name>' });
  const problems = results.filter((r) => !r.ok).length + errs.length + ctrlIssues.filter((c) => c.level === 'error').length;
  return { results, errs, ctrlIssues, problems };
}
