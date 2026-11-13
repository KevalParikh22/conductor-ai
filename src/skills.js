// Skills: one library for every controller and worker.
//
//   ~/.config/conductor/skills/<name>/       global: every project gets it (switch it off per project)
//   <project>/.conductor/skills/<name>/      this project only (wins over a global skill of the same name)
//
// A skill is the standard SKILL.md (name + description frontmatter, Markdown body, optional extra files), the format
// Claude Code, Antigravity, Codex and OpenCode all read. `sync` copies the active ones into .claude/skills/ and
// .agents/skills/ so each controller loads them natively. For workers, conductor adds only the skills that match the
// task: optional `metadata` in the frontmatter says when (roles, files, text), the same way routing rules match.
//
//   ---
//   name: magento-conventions
//   description: How modules, plugins and DI are written in this codebase
//   metadata:
//     files: "*.php, app/code/**"
//     roles: build, fix, test
//   ---
import fs from 'node:fs';
import path from 'node:path';
import { GLOBAL_DIR } from './util.js';
import { PROJECT_DIRNAME, readScope, writeScope } from './config.js';
import { globToRegex } from './routing.js';
import { execFileSync } from 'node:child_process';
import { readBlock, writeBlock } from './localfiles.js';
import { CONTROLLERS } from './presets.js';

export const globalSkillsDir = () => path.join(GLOBAL_DIR, 'skills');
export const projectSkillsDir = (root) => path.join(root, PROJECT_DIRNAME, 'skills');
// where controllers load skills from; Antigravity, Codex, OpenCode and Copilot read .agents/skills
export const TARGETS = [...new Set(Object.values(CONTROLLERS).map((c) => c.skills).filter(Boolean))]; // from the controller registry (V6)
const MARK = '.conductor-skill'; // marks a synced copy, so conductor only ever removes its own
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INLINE_MAX = 6000; // characters of skill text inlined for API workers, which can't open files

/** Frontmatter (name, description, metadata map) and body of a SKILL.md. */
export function parseSkill(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = { metadata: {} };
  let inMeta = false;
  for (const line of (m?.[1] || '').split(/\r?\n/)) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
    const kv = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const val = kv[3].trim().replace(/^["']|["']$/g, '');
    if (inMeta && kv[1].length) meta.metadata[kv[2]] = val;
    else { inMeta = false; meta[kv[2]] = val; }
  }
  return { ...meta, body: (m ? m[2] : String(text)).trim() };
}

function readDir(dir, scope) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md'))).map((n) => {
    const file = path.join(dir, n, 'SKILL.md');
    const s = parseSkill(fs.readFileSync(file, 'utf8'));
    return { name: n, title: s.name || n, description: s.description || '', when: s.metadata || {}, scope, dir: path.join(dir, n), file };
  });
}

/** Every skill for this project: project skills override global ones of the same name; `on` reflects the project's choice. */
export function listSkills(root) {
  const off = new Set(readScope('project', root).skills?.off || []);
  const byName = new Map();
  for (const s of readDir(globalSkillsDir(), 'global')) byName.set(s.name, s);
  for (const s of readDir(projectSkillsDir(root), 'project')) byName.set(s.name, { ...s, overrides: byName.has(s.name) });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ ...s, on: !off.has(s.name) }));
}

/** Switch a skill on or off for this project (stored in .conductor/config.json → skills.off). */
export function setSkillOn(root, name, on) {
  const data = readScope('project', root);
  const off = new Set(data.skills?.off || []);
  if (on) off.delete(name); else off.add(name);
  data.skills = { ...(data.skills || {}), off: [...off].sort() };
  if (!data.skills.off.length) delete data.skills.off;
  if (!Object.keys(data.skills).length) delete data.skills;
  writeScope('project', root, data);
}

/** Create a skill from a template. scope: 'global' | 'project'. */
export function newSkill(root, name, { scope = 'global', description = '', body = '', files = '', roles = '', text = '' } = {}) {
  if (!NAME_RE.test(name)) throw new Error('skill names are lowercase letters, digits and dashes (e.g. php-conventions)');
  const dir = path.join(scope === 'project' ? projectSkillsDir(root) : globalSkillsDir(), name);
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`skill "${name}" already exists (${dir})`);
  const meta = Object.entries({ files, roles, text }).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description || `What ${name} covers and when to use it`)}\n${meta.length ? `metadata:\n${meta.join('\n')}\n` : ''}---\n\n${body || `# ${name}\n\nWrite the instructions here: conventions, steps, examples, what to avoid.\n`}`);
  return dir;
}

/** Copy a skill folder (or a single SKILL.md) into the library. */
export function addSkill(root, src, { scope = 'global', name } = {}) {
  const abs = path.resolve(src);
  const isFile = fs.statSync(abs).isFile();
  const from = isFile ? path.dirname(abs) : abs;
  const skillFile = isFile ? abs : path.join(abs, 'SKILL.md');
  if (!fs.existsSync(skillFile)) throw new Error(`no SKILL.md in ${src}`);
  const n = name || parseSkill(fs.readFileSync(skillFile, 'utf8')).name || path.basename(from);
  if (!NAME_RE.test(n)) throw new Error(`"${n}" is not a valid skill name (lowercase letters, digits and dashes)`);
  const dir = path.join(scope === 'project' ? projectSkillsDir(root) : globalSkillsDir(), n);
  if (isFile) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(abs, path.join(dir, 'SKILL.md')); } else fs.cpSync(from, dir, { recursive: true });
  return { name: n, dir };
}

/** Delete a skill from the library (and its synced copies in this project). */
export function removeSkill(root, name, { scope } = {}) {
  const s = listSkills(root).find((x) => x.name === name && (!scope || x.scope === scope));
  if (!s) throw new Error(`no skill "${name}"${scope ? ` in the ${scope} library` : ''}`);
  fs.rmSync(s.dir, { recursive: true, force: true });
  syncSkills(root);
  return s;
}

/** Save new SKILL.md text for a skill (UI editor). */
export function saveSkill(root, name, text) {
  const s = listSkills(root).find((x) => x.name === name);
  if (!s) throw new Error(`no skill "${name}"`);
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) throw new Error('SKILL.md must start with --- frontmatter (name, description) ---');
  fs.writeFileSync(s.file, text);
  return s;
}

/**
 * Copy the active skills into .claude/skills/ and .agents/skills/, remove copies of skills that are off or gone, and
 * keep the copies out of git. Only folders conductor made (marked) are ever replaced or removed.
 */
export function syncSkills(root) {
  const active = listSkills(root).filter((s) => s.on);
  const want = new Set(active.map((s) => s.name));
  const report = { added: [], updated: [], removed: [], skipped: [] };
  for (const t of TARGETS) {
    const base = path.join(root, t);
    for (const s of active) {
      const dst = path.join(base, s.name);
      const ours = fs.existsSync(path.join(dst, MARK));
      if (fs.existsSync(dst) && !ours) { report.skipped.push(`${t}/${s.name} (your own skill is there)`); continue; }
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(s.dir, dst, { recursive: true });
      fs.writeFileSync(path.join(dst, MARK), `managed by conductor: edit ${s.file} instead, then run conductor skills sync\n`);
      (ours ? report.updated : report.added).push(`${t}/${s.name}`);
    }
    let names = [];
    try { names = fs.readdirSync(base); } catch { /* none */ }
    for (const n of names) {
      if (!want.has(n) && fs.existsSync(path.join(base, n, MARK))) { fs.rmSync(path.join(base, n), { recursive: true, force: true }); report.removed.push(`${t}/${n}`); }
    }
  }
  // keep synced copies out of git through git's local exclude file, so adding or switching a skill never changes
  // .gitignore (only when conductor manages this project's ignores: not with init --share)
  const block = readBlock(root);
  if (block.length) {
    const stale = block.filter((e) => TARGETS.some((t) => e.startsWith(`${t}/`)) && !e.includes('conduct-'));
    if (stale.length) writeBlock(root, block.filter((e) => !stale.includes(e))); // from an earlier version
    writeExclude(root, TARGETS.flatMap((t) => active.map((s) => `/${t}/${s.name}/`)));
  }
  return report;
}

const EX_START = '# >>> conductor skills (synced copies)', EX_END = '# <<< conductor skills';
/** Replace conductor's block in .git/info/exclude (local to this clone, never committed). */
function writeExclude(root, entries) {
  let dir;
  try { dir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return; }
  const file = path.join(path.isAbsolute(dir) ? dir : path.join(root, dir), 'info', 'exclude');
  let cur = ''; try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const i = cur.indexOf(EX_START), j = cur.indexOf(EX_END);
  const rest = i >= 0 && j > i ? cur.slice(0, i) + cur.slice(j + EX_END.length) : cur;
  const next = `${rest.trimEnd()}${rest.trim() ? '\n' : ''}${entries.length ? `${EX_START}\n${entries.join('\n')}\n${EX_END}\n` : ''}`;
  if (next === cur) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Does a skill's `metadata` (roles, files, text) match this task? A skill with none of them applies to every task. */
export function skillMatches(s, { role, files = [], body = '' }) {
  const w = s.when || {};
  if (!w.roles && !w.files && !w.text) return true;
  if (w.roles && !list(w.roles).includes(role)) return false;
  if (w.files) { const res = list(w.files).map(globToRegex); if (!files.some((f) => res.some((re) => re.test(f.replace(/^\.\//, ''))))) return false; }
  if (w.text) { try { if (!new RegExp(w.text, 'i').test(body)) return false; } catch { return false; } }
  return true;
}

/**
 * The skills section of a worker's prompt. Agents get each matching skill's name, description and path (they open
 * the ones they need, like their own skills); API models can't open files, so they get the text, up to a cap.
 */
export function skillsForTask(root, task, { inline = false } = {}) {
  const hits = listSkills(root).filter((s) => s.on && skillMatches(s, task));
  if (!hits.length) return { names: [], text: '' };
  const where = (s) => (fs.existsSync(path.join(root, '.agents/skills', s.name, 'SKILL.md')) ? `.agents/skills/${s.name}/SKILL.md` : s.file);
  let text = '## Skills for this task\nFollow these where they apply. They are the project\'s conventions, not optional style tips.\n';
  if (!inline) {
    text += hits.map((s) => `- **${s.title}**: ${s.description} (read ${where(s)})`).join('\n') + '\n';
  } else {
    let left = INLINE_MAX;
    for (const s of hits) {
      const body = parseSkill(fs.readFileSync(s.file, 'utf8')).body;
      if (body.length > left) { text += `\n### ${s.title}\n${s.description} (too long to include here)\n`; continue; }
      text += `\n### ${s.title}\n${body}\n`; left -= body.length;
    }
  }
  return { names: hits.map((s) => s.name), text };
}
