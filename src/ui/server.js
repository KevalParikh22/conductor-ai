// Local settings UI: http://127.0.0.1:4545. Binds to localhost only and requires a per-launch token.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, findProjectRoot, readScope, writeScope, scopeSave, validateConfig, GLOBAL_CONFIG, GLOBAL_SECRETS, GLOBAL_SECRETS as SECRETS, projectConfigPath, loadSecrets, writeSecrets } from '../config.js';
import { DEFAULT_CONFIG, CLI_PRESETS, ROLES, CONTROLLERS, controllerWorker } from '../presets.js';
import { statusData } from '../status.js';
import { listRuns, runDetail, recheckRuns } from '../runs.js';
import { importAnswer, ImportError } from '../manual.js';
import { dispatch } from '../core.js';
import { qualityStats, failureStats, qualityTrend } from '../stats.js';
import { readLessons, addLesson, removeLesson, promoteLesson, promotable, GUIDANCE } from '../lessons.js';
import { readRules, rulesDir, allControllers } from '../controllers.js';
import { readVerifyState, switchGuards, guardsOn, GUARD_SUPPORTED } from '../guard.js';
import { catalogStatus, addProviderAuto } from '../setup.js';
import { detectLocal } from '../local.js';
import { listSkills, setSkillOn, newSkill, removeSkill, saveSkill, syncSkills, globalSkillsDir, projectSkillsDir } from '../skills.js';
import { ROUTE_TEMPLATES, resolveTemplate, addTemplates } from '../routing.js';
import { usageReport } from '../usage.js';
import { testProvider } from '../providers.js';
import { listFreeModels, listProviderModels } from '../models.js';
import { initProject, setupGlobal } from '../init.js';
import { clearCooldowns, getCooldowns, chooseChain } from '../core.js';
import { deepMerge, isPlainObject, which, loadEnvFile } from '../util.js';
import { VERSION } from '../version.js';
import * as git from '../git.js';
import { ACCOUNT_KINDS, providersWithAccounts, accountStatus, addAccount, renameAccount, removeAccount, orderAccounts, setAccountEnabled, checkAccount } from '../accounts.js';
import { UsageError } from '../core.js';

/** Minimal override: only what differs from `base`. */
export { deepDiff } from '../util.js';

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


function skillsState(root, sync) {
  return { skills: listSkills(root).map((s) => ({ ...s, text: fs.readFileSync(s.file, 'utf8') })), dirs: { global: globalSkillsDir(), project: projectSkillsDir(root) }, sync: sync || null };
}

function stateFor(root) {
  const cfg = loadConfig(root);
  const globalScope = readScope('global', root);
  const inRepo = git.isRepo(root);
  return {
    version: VERSION, root, inRepo, hasProjectConfig: fs.existsSync(projectConfigPath(root)),
    paths: { global: GLOBAL_CONFIG, secrets: GLOBAL_SECRETS, project: projectConfigPath(root) },
    effective: { controller: cfg.controller, providers: cfg.providers, roles: cfg.roles, settings: cfg.settings, routes: cfg.routes || [] },
    notices: cfg.notices || [], // kept out of `effective`: that object is sent back on save
    bases: { global: DEFAULT_CONFIG, project: deepMerge(DEFAULT_CONFIG, globalScope) },
    builtinProviders: Object.keys(DEFAULT_CONFIG.providers),
    accountKinds: Object.keys(ACCOUNT_KINDS),
    status: statusData(cfg), secrets: secretsState(cfg), cooldowns: getCooldowns(), errors: validateConfig(cfg),
    controllerPreset: cfg.providers[controllerWorker(cfg.controller)]?.preset || null, // the controller's own CLI: never suggested as a worker
    presets: Object.fromEntries(Object.entries(CLI_PRESETS).map(([k, v]) => [k, { label: v.label, bin: v.bin, install: v.install, login: v.login, docs: v.docs, permissions: v.permissions || null, takesModel: !!v.modelArgs?.length, installed: !!which(v.bin), beta: !!v.beta }])),
    roles: ROLES, controllers: allControllers(root), catalog: catalogStatus(cfg),
    env: { node: process.version, platform: os.platform(), conductorOnPath: !!which('conductor-ai'), git: !!which('git'), home: os.homedir() },
  };
}

/**
 * The newest `count` sections of CHANGELOG.md as plain text: each heading plus the first sentence of its
 * top-level bullets, so the bell panel stays short. The file ships in the npm package (package.json "files").
 */
export function whatsNew(file = new URL('../../CHANGELOG.md', import.meta.url), { count = 2, maxItems = 12 } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { sections: [] }; }
  const plain = (s) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  const first = (s) => { const m = plain(s).match(/^.*?[.!?](?=\s|$)/); return (m ? m[0] : plain(s)).slice(0, 200); };
  const sections = [];
  let cur = null, items = 0;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^## (.+)/);
    if (h) {
      if (sections.length >= count || items >= maxItems) break;
      cur = { heading: plain(h[1]), items: [] }; sections.push(cur); continue;
    }
    const b = line.match(/^- (.+)/); // top level only: nested bullets are detail
    if (cur && b && items < maxItems) { cur.items.push(first(b[1])); items++; }
  }
  return { sections: sections.filter((s) => s.items.length) };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* print URL instead */ }
}

function lessonsState(root) {
  const all = readLessons(root);
  const promo = new Set(promotable(all).map((l) => l.id));
  return { lessons: all.slice().reverse().map((l) => ({ ...l, text: l.text || GUIDANCE[l.kind] || l.kind, promote: promo.has(l.id) })) };
}
function guardState(root) {
  const controller = loadConfig(root).controller || 'claude-code';
  return { controller, supported: !!GUARD_SUPPORTED[controller], on: GUARD_SUPPORTED[controller] ? guardsOn(root, controller) : false, file: GUARD_SUPPORTED[controller] || null, lastVerify: readVerifyState(root) };
}

let rechecking = false; // POST /api/recheck runs one at a time
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
    if (req.headers['x-conductor-token'] !== token) return send(401, { error: 'missing or wrong token: open the URL printed by `conductor-ai ui`' });

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
        case 'GET /api/accounts': {
          const cfg = loadConfig(root);
          const providers = Object.fromEntries(providersWithAccounts(cfg).map((provider) => [provider, accountStatus(cfg, provider)]));
          return send(200, { providers });
        }
        case 'POST /api/accounts/add': addAccount(String(body.provider || ''), String(body.label || '')); return send(200, accountList(body.provider));
        case 'POST /api/accounts/rename': renameAccount(String(body.provider || ''), String(body.from || ''), String(body.to || '')); return send(200, accountList(body.provider));
        case 'POST /api/accounts/remove': {
          if (body.confirm !== true) return send(400, { error: 'confirm must be true to remove an account and its login folder' });
          removeAccount(String(body.provider || ''), String(body.label || '')); return send(200, accountList(body.provider));
        }
        case 'POST /api/accounts/order': orderAccounts(String(body.provider || ''), body.labels); return send(200, accountList(body.provider));
        case 'POST /api/accounts/toggle': setAccountEnabled(String(body.provider || ''), String(body.label || ''), !!body.enabled); return send(200, accountList(body.provider));
        case 'POST /api/accounts/check': {
          const provider = String(body.provider || ''), cfg = loadConfig(root);
          if (body.label) await checkAccount(cfg, provider, String(body.label));
          else await Promise.all((cfg.providers[provider]?.accounts || []).map((a) => checkAccount(cfg, provider, a.label)));
          return send(200, accountList(provider));
        }
        case 'PUT /api/config': {
          const scope = body.scope === 'global' ? 'global' : 'project';
          const eff = body.effective || {};
          const errors = validateConfig({ ...deepMerge(DEFAULT_CONFIG, eff) });
          if (errors.length) return send(400, { error: errors.join('; ') });
          // only what was changed on the page goes to the chosen file: saving to global no longer copies this
          // project's own overrides into every project, and saving to the project doesn't freeze global values here
          const { data, shadowed } = scopeSave(scope, root, eff);
          // keep the controller pinned in the project file once a project is initialised
          if (scope === 'project') data.controller = data.controller || eff.controller || loadConfig(root).controller;
          if (scope === 'global') setupGlobal();
          writeScope(scope, root, data);
          return send(200, { ...stateFor(root), shadowed });
        }
        case 'POST /api/test': {
          const cfg = loadConfig(root);
          const p = body.provider || cfg.providers[body.name];
          if (!p) return send(404, { error: 'unknown provider' });
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-test-'));
          try { return send(200, await testProvider(body.name, { ...p, enabled: true }, root, dir)); }
          finally { fs.rmSync(dir, { recursive: true, force: true }); }
        }
        // V3: the same actions as the CLI and MCP (src/surfaces.js)
        case 'GET /api/whatsnew': return send(200, whatsNew());
        case 'GET /api/stats': return send(200, { quality: qualityStats({ root }), failures: failureStats({ root }), trend: qualityTrend({ root }) });
        case 'GET /api/lessons': return send(200, lessonsState(root));
        case 'POST /api/lessons/add': {
          const text = String(body.text || '').trim();
          if (!text) return send(400, { error: 'a lesson needs text' });
          addLesson(root, { source: 'manual', text: text.slice(0, 300), role: body.role || null, files: Array.isArray(body.files) ? body.files.map(String) : [] });
          return send(200, lessonsState(root));
        }
        case 'POST /api/lessons/remove': return removeLesson(root, String(body.id || '')) ? send(200, lessonsState(root)) : send(404, { error: 'no such lesson' });
        case 'POST /api/lessons/promote': { const r = promoteLesson(root, String(body.id || '')); return r ? send(200, { ...lessonsState(root), bullet: r.bullet }) : send(404, { error: 'no such lesson' }); }
        case 'GET /api/rules': return send(200, { rules: readRules(root), dir: path.relative(root, rulesDir(root)).split(path.sep).join('/') });
        case 'GET /api/guard': return send(200, guardState(root));
        case 'POST /api/guard': {
          const controller = loadConfig(root).controller || 'claude-code';
          const r = switchGuards(root, controller, !!body.on);
          if (r.unsupported) return send(400, { error: 'guards are only available for Claude Code and Antigravity' });
          return send(200, guardState(root));
        }
        case 'POST /api/import': {
          try {
            const s = await importAnswer(loadConfig(root), String(body.run || ''), body.text, { dispatch });
            return send(200, { run: (s.runDir || '').split('/').pop(), outcome: s.outcome || null, exitCode: s.exitCode });
          } catch (e) { if (e instanceof ImportError) return send(400, { error: e.message }); throw e; }
        }
        case 'GET /api/run': {
          const d = runDetail(root, String(url.searchParams.get('id') || ''));
          return d ? send(200, d) : send(404, { error: 'no such run' });
        }
        case 'POST /api/recheck': {
          // one at a time: each checks out code and runs the project's checks
          if (rechecking) return send(409, { error: 'a recheck is already running' });
          rechecking = true;
          try { return send(200, { rows: await recheckRuns(root, Array.isArray(body.ids) ? body.ids.map(String) : [], loadConfig(root).settings) }); }
          finally { rechecking = false; }
        }
        case 'GET /api/runs': return send(200, { runs: listRuns(root, { limit: 50 }), usage: usageReport(7), budget: loadConfig(root).settings.dailyBudgetUSD || 0 });
        case 'GET /api/models': return send(200, { models: await listFreeModels() });
        case 'POST /api/providers/add': {
          const r = await addProviderAuto(root, String(body.id || ''), { key: body.key || undefined, model: body.model || undefined, fields: body.fields || {}, scope: body.scope === 'project' ? 'project' : 'global' });
          return send(200, { ...stateFor(root), added: { name: r.name, model: r.provider.model, roles: r.roles, warning: r.warning } });
        }
        // skills: the same functions as `conductor-ai skills`; every change re-syncs the controller folders
        case 'GET /api/skills': return send(200, skillsState(root));
        case 'POST /api/skills/toggle': setSkillOn(root, String(body.name), !!body.on); return send(200, skillsState(root, syncSkills(root)));
        case 'POST /api/skills/new': newSkill(root, String(body.name || ''), { scope: body.scope === 'project' ? 'project' : 'global', description: body.description, files: body.files, roles: body.roles, text: body.text }); return send(200, skillsState(root, syncSkills(root)));
        case 'POST /api/skills/save': saveSkill(root, String(body.name), String(body.text || '')); return send(200, skillsState(root, syncSkills(root)));
        case 'POST /api/skills/remove': removeSkill(root, String(body.name), { scope: body.scope }); return send(200, skillsState(root));
        case 'POST /api/skills/sync': return send(200, skillsState(root, syncSkills(root)));
        case 'GET /api/local': return send(200, { local: await detectLocal() });
        case 'POST /api/route-templates': {
          // the rule library resolved against the (possibly unsaved) providers; with `add`, the routes with those templates inserted
          const providers = isPlainObject(body.providers) ? body.providers : loadConfig(root).providers;
          const routes = Array.isArray(body.routes) ? body.routes : [];
          const have = new Set(routes.map((r) => r?.from).filter(Boolean));
          const exclude = [controllerWorker(loadConfig(root).controller)]; // never route work to the controller's own CLI
          const templates = ROUTE_TEMPLATES.map((t) => ({ ...resolveTemplate(t, providers, { exclude }), added: have.has(t.id) }));
          if (!Array.isArray(body.add)) return send(200, { templates });
          return send(200, { templates, ...addTemplates(routes, body.add.map(String), providers, { exclude }) });
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
      return send(e instanceof UsageError ? 400 : 500, { error: String(e.message || e) });
    }
  });

  function accountList(provider) {
    const cfg = loadConfig(root);
    return { provider, accounts: accountStatus(cfg, String(provider || '')), providers: providersWithAccounts(cfg) };
  }

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
  console.log(`conductor-ai ui → ${url}\nproject: ${ui.root}\n(Ctrl+C to stop. The token in the URL protects the API; don't share it.)`);
  if (open) openBrowser(url);
}
