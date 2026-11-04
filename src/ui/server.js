// Local settings UI: http://127.0.0.1:4545. Binds to localhost only and requires a per-launch token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, findProjectRoot, readScope, writeScope, validateConfig, GLOBAL_CONFIG, GLOBAL_SECRETS, GLOBAL_SECRETS as SECRETS, projectConfigPath, loadSecrets, writeSecrets } from '../config.js';
import { DEFAULT_CONFIG, CLI_PRESETS, ROLES, CONTROLLERS } from '../presets.js';
import { statusData } from '../status.js';
import { listRuns } from '../runs.js';
import { catalogStatus, addProviderAuto } from '../setup.js';
import { detectLocal } from '../local.js';
import { ROUTE_TEMPLATES, resolveTemplate, addTemplates } from '../routing.js';
import { usageReport } from '../usage.js';
import { testProvider } from '../providers.js';
import { listFreeModels, listProviderModels } from '../models.js';
import { initProject, setupGlobal } from '../init.js';
import { clearCooldowns, getCooldowns, chooseChain } from '../core.js';
import { deepMerge, isPlainObject, which, loadEnvFile } from '../util.js';
import { VERSION } from '../version.js';
import * as git from '../git.js';

/** Minimal override: only what differs from `base`. */
export function deepDiff(base, eff) {
  const out = {};
  for (const [k, v] of Object.entries(eff || {})) {
    const b = base?.[k];
    if (isPlainObject(v) && isPlainObject(b)) { const d = deepDiff(b, v); if (Object.keys(d).length) out[k] = d; }
    else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v;
  }
  return out;
}

function secretsState(cfg) {
  const fileVars = loadEnvFile(SECRETS);
  const names = new Set(['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'ANTHROPIC_API_KEY']);
  for (const p of Object.values(cfg.providers)) if (p.apiKeyEnv) names.add(p.apiKeyEnv);
  return [...names].map((n) => ({
    name: n,
    set: !!process.env[n],
    source: fileVars[n] !== undefined ? 'secrets file' : process.env[n] ? 'environment' : null,
    hint: process.env[n] ? `…${process.env[n].slice(-4)}` : '',
    usedBy: Object.entries(cfg.providers).filter(([, p]) => p.apiKeyEnv === n).map(([k]) => k),
  }));
}


function stateFor(root) {
  const cfg = loadConfig(root);
  const globalScope = readScope('global', root);
  const inRepo = git.isRepo(root);
  return {
    version: VERSION, root, inRepo, hasProjectConfig: fs.existsSync(projectConfigPath(root)),
    paths: { global: GLOBAL_CONFIG, secrets: GLOBAL_SECRETS, project: projectConfigPath(root) },
    effective: { controller: cfg.controller, providers: cfg.providers, roles: cfg.roles, settings: cfg.settings, routes: cfg.routes || [] },
    bases: { global: DEFAULT_CONFIG, project: deepMerge(DEFAULT_CONFIG, globalScope) },
    builtinProviders: Object.keys(DEFAULT_CONFIG.providers),
    status: statusData(cfg), secrets: secretsState(cfg), cooldowns: getCooldowns(), errors: validateConfig(cfg),
    presets: Object.fromEntries(Object.entries(CLI_PRESETS).map(([k, v]) => [k, { label: v.label, bin: v.bin, install: v.install, login: v.login, docs: v.docs, permissions: v.permissions || null, installed: !!which(v.bin) }])),
    roles: ROLES, controllers: CONTROLLERS, catalog: catalogStatus(cfg),
    env: { node: process.version, platform: os.platform(), conductorOnPath: !!which('conductor'), git: !!which('git') },
  };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* print URL instead */ }
}

export function createUiServer({ cwd = process.cwd(), token = crypto.randomBytes(16).toString('hex') } = {}) {
  const root = findProjectRoot(cwd);
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  let allowedHosts = new Set();

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // DNS-rebinding guard: only accept our own Host header
    if (!allowedHosts.has(req.headers.host)) return send(403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, html, 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
    if (req.headers['x-conductor-token'] !== token) return send(401, { error: 'missing or wrong token: open the URL printed by `conductor ui`' });

    let body = {};
    if (req.method !== 'GET') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) return send(413, { error: 'too large' }); }
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'bad json' }); }
    }
    try {
      loadSecrets(root);
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/state': return send(200, stateFor(root));
        case 'PUT /api/config': {
          const scope = body.scope === 'global' ? 'global' : 'project';
          const base = scope === 'global' ? DEFAULT_CONFIG : deepMerge(DEFAULT_CONFIG, readScope('global', root));
          const eff = body.effective || {};
          const errors = validateConfig({ ...deepMerge(base, eff) });
          if (errors.length) return send(400, { error: errors.join('; ') });
          const diff = deepDiff(base, eff);
          // keep the controller pinned in the project file once a project is initialised
          if (scope === 'project') diff.controller = eff.controller || readScope('project', root).controller || base.controller;
          if (scope === 'global') setupGlobal();
          writeScope(scope, root, { version: 1, ...diff });
          return send(200, stateFor(root));
        }
        case 'POST /api/test': {
          const cfg = loadConfig(root);
          const p = body.provider || cfg.providers[body.name];
          if (!p) return send(404, { error: 'unknown provider' });
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-test-'));
          try { return send(200, await testProvider(body.name, { ...p, enabled: true }, root, dir)); }
          finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
        case 'GET /api/runs': return send(200, { runs: listRuns(root, { limit: 50 }), usage: usageReport(7), budget: loadConfig(root).settings.dailyBudgetUSD || 0 });
        case 'GET /api/models': return send(200, { models: await listFreeModels() });
        case 'POST /api/providers/add': {
          const r = await addProviderAuto(root, String(body.id || ''), { key: body.key || undefined, model: body.model || undefined, fields: body.fields || {}, scope: body.scope === 'project' ? 'project' : 'global' });
          return send(200, { ...stateFor(root), added: { name: r.name, model: r.provider.model, roles: r.roles, warning: r.warning } });
        }
        case 'GET /api/local': return send(200, { local: await detectLocal() });
        case 'POST /api/route-templates': {
          // the rule library resolved against the (possibly unsaved) providers; with `add`, the routes with those templates inserted
          const providers = isPlainObject(body.providers) ? body.providers : loadConfig(root).providers;
          const routes = Array.isArray(body.routes) ? body.routes : [];
          const have = new Set(routes.map((r) => r?.from).filter(Boolean));
          const templates = ROUTE_TEMPLATES.map((t) => ({ ...resolveTemplate(t, providers), added: have.has(t.id) }));
          if (!Array.isArray(body.add)) return send(200, { templates });
          return send(200, { templates, ...addTemplates(routes, body.add.map(String), providers) });
        }
        case 'POST /api/route-preview': {
          const cfg = loadConfig(root);
          if (Array.isArray(body.routes)) cfg.routes = body.routes; // preview unsaved rules
          if (body.roles) cfg.roles = { ...cfg.roles, ...body.roles };
          const role = ROLES[body.role] ? body.role : 'build';
          const files = String(body.files || '').split(',').map((x) => x.trim()).filter(Boolean);
          const r = chooseChain(cfg, role, { body: String(body.task || ''), files });
          return send(200, { role, how: r.how, note: r.note, chain: r.chain.map((c) => ({ name: c.name, skip: c.skip || null })) });
        }
        case 'POST /api/provider-models': {
          const p = loadConfig(root).providers[body.name];
          if (!p || p.type === 'cli') return send(400, { error: 'not an API provider' });
          return send(200, await listProviderModels(p, { freeOnly: false }));
        }
        case 'PUT /api/secrets': writeSecrets(body.updates || {}); return send(200, stateFor(root));
        case 'POST /api/init': {
          setupGlobal();
          const r = initProject(root, { controller: body.controller || 'claude-code', mcp: body.mcp !== false });
          return send(200, { ...r, state: stateFor(root) });
        }
        case 'POST /api/cooldowns/clear': clearCooldowns(body.name); return send(200, stateFor(root));
        default: return send(404, { error: 'not found' });
      }
    } catch (e) {
      return send(500, { error: String(e.message || e) });
    }
  });

  return {
    server, token, root,
    listen(port = 4545) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const p = server.address().port;
          allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
          resolve(p);
        });
      });
    },
  };
}

export async function startUi({ port = 4545, open = true, cwd } = {}) {
  const ui = createUiServer({ cwd });
  let p;
  try { p = await ui.listen(port); } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    p = await ui.listen(0); // pick a free port
  }
  const url = `http://127.0.0.1:${p}/#t=${ui.token}`;
  console.log(`conductor ui → ${url}\nproject: ${ui.root}\n(Ctrl+C to stop. The token in the URL protects the API; don't share it.)`);
  if (open) openBrowser(url);
}
