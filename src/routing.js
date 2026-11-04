// Routing: you decide which provider takes a task, by plan line or by rule.
//
//   In a plan task:   - **provider:** codex-cli            (or a list: codex-cli, kilo-free)
//   In config:        "routes": [
//                       { "files": "src/frontend/**", "provider": "grok-cli" },
//                       { "text": "migration|schema", "role": "build", "provider": ["codex-cli", "antigravity-cli"] }
//                     ]
//
// A route matches when every condition it names holds: `role` equals the task's role, `files` (a glob, or a
// list of globs) matches at least one of the task's files, `text` (a case-insensitive regex) matches the task
// text. The first matching route wins. Its providers go first; the role's chain stays behind them as fallback.
// Precedence, highest first: --chain, --provider, the plan task's provider line, routes, smart selector.

/** Glob to RegExp: ** spans folders, * stays inside one, ? is one character. A pattern without "/" matches the file name anywhere. */
export function globToRegex(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim()).filter(Boolean);

/** Providers named on a plan task's "provider:" line. */
export function taskProviders(section = '') {
  const m = section.match(/\*\*providers?:\*\*\s*(.+)/i);
  return m ? list(m[1].replace(/`/g, '')) : [];
}

/** The first route that matches this task, with its index, or null. */
export function matchRoute(routes = [], { role, body = '', files = [] }) {
  for (const [i, r] of routes.entries()) {
    if (!r || (!r.files && !r.text && !r.role)) continue;
    if (r.role && list(r.role).length && !list(r.role).includes(role)) continue;
    if (r.files) {
      const res = list(r.files).map(globToRegex);
      if (!files.some((f) => res.some((re) => re.test(f.replace(/^\.\//, ''))))) continue;
    }
    if (r.text) {
      let re;
      try { re = new RegExp(r.text, 'i'); } catch { continue; }
      if (!re.test(body)) continue;
    }
    return { index: i, route: r, providers: list(r.provider) };
  }
  return null;
}

/** Readable description of a route, for summaries and the UI. */
export function describeRoute(r) {
  const when = [r.role && `role ${list(r.role).join('/')}`, r.files && `files ${list(r.files).join(', ')}`, r.text && `text /${r.text}/`].filter(Boolean).join(' + ');
  return `${when || 'any task'} → ${list(r.provider).join(', ')}`;
}

/** Config problems with routes (for validateConfig). */
export function routeErrors(routes, providers) {
  if (routes === undefined) return [];
  if (!Array.isArray(routes)) return ['routes must be a list'];
  const errors = [];
  routes.forEach((r, i) => {
    if (!r || typeof r !== 'object') return errors.push(`route ${i + 1}: must be an object`);
    if (!r.files && !r.text && !r.role) errors.push(`route ${i + 1}: needs "files", "text" or "role" to match on`);
    if (!list(r.provider).length) errors.push(`route ${i + 1}: needs a "provider"`);
    for (const p of list(r.provider)) if (!providers?.[p]) errors.push(`route ${i + 1}: unknown provider "${p}"`);
    if (r.text) { try { new RegExp(r.text); } catch { errors.push(`route ${i + 1}: "text" is not a valid regex`); } }
  });
  return errors;
}

// Rule library: ready-made rules you can add with `conductor route --add <id>` or in the UI (Roles → Routing).
// Each names the kind of worker it wants; `resolveTemplate` fills in your enabled providers of that kind.
// Listed in the order they should sit in `routes`: risky work first, so it wins over the broader rules below it.
const STRONG = ['claude-cli', 'codex-cli', 'antigravity-cli', 'kiro-cli', 'copilot-cli', 'opencode', 'grok-cli', 'goose', 'aider', 'kimi-cli'];
const UI_AGENTS = ['antigravity-cli', 'claude-cli', 'codex-cli', 'grok-cli', 'copilot-cli', 'opencode', 'kiro-cli', 'goose', 'aider', 'kimi-cli'];
const TEST_AGENTS = ['opencode', 'codex-cli', 'antigravity-cli', 'claude-cli', 'copilot-cli', 'kiro-cli', 'goose', 'aider', 'grok-cli', 'kimi-cli'];
const CHEAP = ['ollama', 'lmstudio', 'kilo-free', 'openrouter-free', 'gemini-api'];

export const ROUTE_TEMPLATES = [
  { id: 'security', label: 'Security-sensitive code', starter: true, want: 'strong',
    rule: { text: '\\b(auth|login|password|token|secret|session|payment|checkout|permission|encrypt|csrf|oauth)' },
    why: 'Logins, payments and secrets go to the agent you trust most, never to a free model.' },
  { id: 'database', label: 'Database and migrations', starter: true, want: 'strong',
    rule: { files: ['*.sql', '**/migrations/**', '**/migration/**', '**/db/**', '**/Setup/**'] },
    why: 'Schema changes are hard to undo, so a strong agent that can run and check them does it.' },
  { id: 'infra', label: 'CI, Docker and infrastructure', starter: true, want: 'strong',
    rule: { files: ['Dockerfile', 'docker-compose*.yml', '.github/**', '*.tf', '**/k8s/**', 'nginx*.conf', 'Makefile'] },
    why: 'A wrong line here breaks builds or deploys for everyone.' },
  { id: 'small-edits', label: 'Small edits (typos, renames, lint)', starter: true, want: 'cheap',
    rule: { text: '\\b(typo|spelling|rename|comment|docstring|lint|format(ting)?|whitespace)\\b' },
    why: 'Tiny changes cost nothing on a free or local model.' },
  { id: 'tests', label: 'Test files', want: 'tests',
    rule: { files: ['*.test.*', '*.spec.*', '*Test.php', '**/tests/**', '**/test/**', '**/__tests__/**'] },
    why: 'Writing tests needs an agent that can run them and read the failures.' },
  { id: 'frontend', label: 'Frontend and styling', want: 'ui',
    rule: { files: ['*.tsx', '*.jsx', '*.vue', '*.svelte', '*.css', '*.scss', '*.less', '*.html', '*.phtml'] },
    why: 'UI work goes to the agent you find best at layout and components.' },
  { id: 'backend', label: 'Backend code', want: 'strong',
    rule: { files: ['*.php', '*.py', '*.go', '*.rb', '*.java', '*.cs', '*.rs'] },
    why: 'Server logic goes to a strong coding agent.' },
  { id: 'docs-files', label: 'Docs and Markdown', starter: true, want: 'cheap',
    rule: { files: ['*.md', '*.mdx', '*.rst', 'docs/**'] },
    why: 'Writing docs does not need an expensive model.' },
  { id: 'translations', label: 'Translations', want: 'cheap',
    rule: { files: ['**/locales/**', '**/i18n/**', '**/lang/**', '*.po'] },
    why: 'Translation files are repetitive text: a free model handles them.' },
  { id: 'docs-role', label: 'Docs role on a free or local model', starter: true, want: 'local',
    rule: { role: 'docs' },
    why: 'Every docs task tries a free or local model first.' },
  { id: 'ask-role', label: 'Questions on a local model', want: 'local',
    rule: { role: 'ask' },
    why: 'Questions about your code stay on your machine when a local model is on.' },
  { id: 'review-role', label: 'Reviews by a strong agent', want: 'strong',
    rule: { role: 'review' },
    why: 'A careful reviewer catches what the writer missed.' },
];

export const WANT_LABELS = { strong: 'your strongest agent', ui: 'an agent good at UI', tests: 'an agent that runs tests', cheap: 'a free or local model', local: 'a local model, else a free one' };

const isLocalUrl = (u = '') => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u);

/** Up to two enabled providers of the kind a template wants, best first. */
export function wantProviders(want, providers = {}) {
  const on = (n) => providers[n]?.enabled;
  const cli = (n) => providers[n]?.type === 'cli';
  const free = (n) => providers[n]?.type !== 'cli' && (providers[n]?.free || isLocalUrl(providers[n]?.baseUrl));
  const local = (n) => providers[n]?.type !== 'cli' && isLocalUrl(providers[n]?.baseUrl);
  const all = Object.keys(providers).filter(on);
  const pick = {
    strong: [...STRONG, ...all.filter(cli)],
    ui: [...UI_AGENTS, ...all.filter(cli)],
    tests: [...TEST_AGENTS, ...all.filter(cli)],
    cheap: [...all.filter(local), ...CHEAP, ...all.filter(free)],
    local: [...all.filter(local), ...CHEAP, ...all.filter(free)],
  }[want] || [];
  return [...new Set(pick)].filter((n) => on(n) && (want === 'cheap' || want === 'local' ? !cli(n) : cli(n))).slice(0, 2);
}

/** A template as a route for these providers: { id, label, why, route, missing }. */
export function resolveTemplate(t, providers) {
  const provider = wantProviders(t.want, providers);
  const route = { ...t.rule, provider: provider.length === 1 ? provider[0] : provider, from: t.id };
  return { id: t.id, label: t.label, why: t.why, starter: !!t.starter, want: WANT_LABELS[t.want], route,
    missing: provider.length ? null : `enable ${WANT_LABELS[t.want]} first` };
}

/**
 * Add templates to a routes list, keeping the library's order among template rules (risky ones first).
 * Returns { routes, added, skipped: [{ id, why }] }. A template already in the list is skipped.
 */
export function addTemplates(routes = [], ids, providers) {
  const order = (r) => ROUTE_TEMPLATES.findIndex((t) => t.id === r?.from);
  const out = [...routes], added = [], skipped = [];
  for (const id of ids) {
    const t = ROUTE_TEMPLATES.find((x) => x.id === id);
    if (!t) { skipped.push({ id, why: 'no such template' }); continue; }
    if (out.some((r) => r?.from === id)) { skipped.push({ id, why: 'already added' }); continue; }
    const r = resolveTemplate(t, providers);
    if (r.missing) { skipped.push({ id, why: r.missing }); continue; }
    const mine = order(r.route);
    const at = out.findIndex((x) => order(x) > mine);
    out.splice(at < 0 ? out.length : at, 0, r.route);
    added.push(id);
  }
  return { routes: out, added, skipped };
}

export const starterIds = () => ROUTE_TEMPLATES.filter((t) => t.starter).map((t) => t.id);
