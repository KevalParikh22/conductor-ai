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
