// conductor doctor: what is installed, which keys are set, whether each enabled provider answers (live) and may run
// the commands workers need, config errors and the controller's files. The CLI, MCP and UI share this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, providerPermissions, readOnlyEnforced, optionalNoKey, providerLocation } from './config.js';
import { localWindow } from './local.js';
import { CLI_PRESETS, CONTROLLERS } from './presets.js';
import { testProvider, testPermissions } from './providers.js';
import { checkControllerFiles, allControllers, controllerErrors } from './controllers.js';
import { which, keyValue, untilText } from './util.js';
import { getCooldowns } from './cooldowns.js';

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
    // a rate limit pauses a provider; it isn't broken (status shows the same)
    const cd = getCooldowns()[name];
    if (cd) Object.assign(r, { cooling: true, status: `cooling down until ${untilText(cd.until)} (${cd.reason})`, next: `it waits; to try it now: conductor cooldown --clear ${name}` });
    if (live) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-doctor-'));
      const t = await testProvider(name, p, cfg.root, dir);
      fs.rmSync(dir, { recursive: true, force: true });
      Object.assign(r, { ok: t.ok, status: t.reason, sample: t.ok ? undefined : t.sample.replace(/\s+/g, ' ').slice(0, 120),
        next: t.ok ? null : p.catalog ? `see docs/providers/${p.catalog}.md → Troubleshooting` : null });
      // V13: a model on this machine: the window it really runs with (a longer prompt is cut without an error)
      if (t.ok && providerLocation(p) === 'local-model' && p.model) {
        const w = await localWindow(p);
        if (w) { r.window = w; r.status = `${t.reason}; runs with a ${w.window}-token window${w.trained > w.window ? ` (the model supports ${w.trained})` : ''}`; if (w.window < 8192) r.next = `small for conductor's prompts (often 4,000–15,000 tokens): set OLLAMA_CONTEXT_LENGTH=16384 for the server and restart it, or use a model with PARAMETER num_ctx`; }
      }
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
  const cmd = conductorCommandCheck();
  if (cmd.ok === false) ctrlIssues.push({ level: 'warn', file: 'PATH', problem: cmd.problem, fix: cmd.fix });
  // V6: your own controller entries must name formats conductor can write
  for (const [n, c] of Object.entries(allControllers(cfg.root))) {
    if (CONTROLLERS[n]) continue;
    for (const e of controllerErrors(n, c)) ctrlIssues.push({ level: 'error', file: `controllers.${n}`, problem: e, fix: 'conductor controller check, then fix the entry in your config' });
  }
  if (!allControllers(cfg.root)[cfg.controller || 'claude-code']) ctrlIssues.push({ level: 'error', file: 'controller', problem: `unknown controller "${cfg.controller}"`, fix: 'conductor controller list, then conductor init --controller <name>' });
  const problems = results.filter((r) => !r.ok).length + errs.length + ctrlIssues.filter((c) => c.level === 'error').length;
  return { results, errs, ctrlIssues, problems };
}

/**
 * Is the `conductor` command on PATH this program? Other tools install a `conductor` command too (Conductor OSS's
 * `@conductor-oss/conductor-cli`, the `conductor-cli` package); with both installed, the last one installed wins.
 * → { ok: true } | { ok: false, path, problem, fix } | { missing: true }
 */
export function conductorCommandCheck(ownBin = new URL('../bin/conductor.js', import.meta.url).pathname) {
  const found = which('conductor');
  if (!found) return { missing: true };
  let real = found, own = ownBin;
  try { real = fs.realpathSync(found); } catch { /* keep the path */ }
  try { own = fs.realpathSync(ownBin); } catch { /* keep the path */ }
  if (real === own) return { ok: true };
  // a wrapper script (npm on Windows, some installers) that points at this program counts as ours
  let text = '';
  try { text = fs.readFileSync(found, 'utf8').slice(0, 2000); } catch { /* binary */ }
  if (text.includes('conductor-ai')) return { ok: true };
  return { ok: false, path: found, problem: `the "conductor" command on your PATH is another program (${real}), not conductor-ai`, fix: 'use the "conductor-ai" command (same program, same options), or put conductor-ai\'s folder first in PATH; your controller\'s MCP entry can use "conductor-ai mcp"' };
}
