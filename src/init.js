// `conductor init`: add conductor to a project for the chosen controller. Never overwrites user files.
// `conductor setup`: first-time global setup (~/.config/conductor).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG } from './presets.js';
import { GLOBAL_CONFIG, GLOBAL_SECRETS, PROJECT_DIRNAME, projectConfigPath } from './config.js';
import { readJSON, writeJSON } from './util.js';
import { detectVerify } from './verify.js';
import { syncSkills } from './skills.js';
import { syncControllerFiles, controllerDef, allControllers } from './controllers.js';
import { BASE_ENTRIES, CREATED_FILES, readBlock, writeBlock, removeBlock, trackedEntries } from './localfiles.js';

const TPL = new URL('../templates/', import.meta.url);
const tpl = (p) => fs.readFileSync(new URL(p, TPL), 'utf8');

function mergeMarkedBlock(file, block, start, end, log) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) { fs.writeFileSync(file, block.trimEnd() + '\n'); log('added', name); return; }
  const cur = fs.readFileSync(file, 'utf8');
  const i = cur.indexOf(start), j = cur.indexOf(end);
  if (i >= 0 && j > i) {
    const next = cur.slice(0, i) + block.trim() + cur.slice(j + end.length);
    if (next !== cur) { fs.writeFileSync(file, next); log('updated', `${name} (conductor block)`); } else log('kept', name);
  } else {
    fs.writeFileSync(file, cur.trimEnd() + '\n\n' + block.trim() + '\n'); log('merged', `${name} (conductor block appended)`);
  }
}

function copyIfMissing(root, relPath, content, log) {
  const abs = path.join(root, relPath);
  if (fs.existsSync(abs)) return log('kept', relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  log('added', relPath);
}

function writeOwned(root, relPath, content, log) {
  const abs = path.join(root, relPath);
  const existed = fs.existsSync(abs);
  if (existed && fs.readFileSync(abs, 'utf8') === content) return log('kept', relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  log(existed ? 'updated' : 'added', relPath);
}

function mergeJsonFile(root, relPath, mutate, log) {
  const abs = path.join(root, relPath);
  const existed = fs.existsSync(abs);
  const data = readJSON(abs, existed ? null : {});
  if (data === null) return log('SKIPPED', `${relPath} (not valid JSON, so add the conductor entry by hand)`);
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return log('kept', relPath);
  writeJSON(abs, data);
  log(existed ? 'merged' : 'added', relPath);
}

/**
 * The /conduct-* command templates as SKILL.md files: for .agents/skills (Antigravity, Codex, OpenCode) and, with
 * plugin: true, for the Claude Code / Antigravity plugin, which keeps Claude's extra fields (argument hint, allowed tools).
 */
export function commandSkills({ plugin = false } = {}) {
  const dir = new URL('commands/', TPL);
  return fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort().map((f) => {
    const { meta, body } = parseCommand(fs.readFileSync(new URL(f, dir), 'utf8'));
    const name = f.replace(/\.md$/, '');
    const text = body.replaceAll('$ARGUMENTS', 'the arguments the user gave')
      .replaceAll('.claude/commands/conduct-build.md', plugin ? 'the conduct-build skill' : '.agents/skills/conduct-build/SKILL.md');
    const extra = plugin ? ['argument-hint', 'disable-model-invocation', 'allowed-tools'].filter((k) => meta[k]).map((k) => `${k}: ${k === 'disable-model-invocation' ? meta[k] : JSON.stringify(meta[k])}\n`).join('') : ''; // quoted: "[--plan <file>]" isn't valid YAML bare
    return { name, content: `---\nname: ${name}\ndescription: ${JSON.stringify(meta.description || name)}\n${extra}---\n\n${text}\n` };
  });
}

/** Split a command template into frontmatter fields and body. */
function parseCommand(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = {};
  for (const line of (m?.[1] || '').split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: (m?.[2] || md).trim() };
}


/** Is conductor registered in Codex's own config (~/.codex/config.toml)? */
export function codexHasConductor(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')) {
  try { return /^\s*\[mcp_servers\.(conductor|"conductor")\]/m.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

/** Is conductor registered as an MCP server in agy's own config (~/.gemini/config/mcp_config.json)? */
export function agyHasConductor(file = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')) {
  try { return !!JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers?.conductor; } catch { return false; }
}

export function initProject(root, { controller = 'claude-code', mcp = true, vscode, share = false, verify: verifyCmd } = {}) {
  const def = controllerDef(controller, root);
  if (!def) throw new Error(`unknown controller "${controller}". Options: ${Object.keys(allControllers(root)).join(', ')}`);
  const lines = [];
  const created = new Set(); // files this run created (not ones you already had)
  const log = (what, p) => { lines.push(`  ${what.padEnd(8)} ${p}`); if (what === 'added') created.add(p.split(/\s/)[0]); };
  const notes = [];

  // 1. AGENTS.md: full template if new, otherwise append just the rules/protocol block
  const agentsPath = path.join(root, 'AGENTS.md');
  const agentsTpl = tpl('AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    // fill in the Verify line from the project's own scripts, so workers and the controller see the real command
    const verify = verifyCmd || detectVerify(root);
    fs.writeFileSync(agentsPath, verify ? agentsTpl.replace(/`<e\.g\. [^`]*>`/, `\`${verify}\``) : agentsTpl);
    log('added', `AGENTS.md   ← fill in section 1 (project facts)${verify ? `; Verify ${verifyCmd ? 'set' : 'detected'}: ${verify}${verifyCmd ? '' : ' (check it)'}` : ' and the Verify command'}`);
  }
  else {
    const s = '<!-- conductor:rules:start -->', e = '<!-- conductor:rules:end -->';
    mergeMarkedBlock(agentsPath, agentsTpl.slice(agentsTpl.indexOf(s), agentsTpl.indexOf(e) + e.length), s, e, log);
    if (verifyCmd) setVerifyLine(agentsPath, verifyCmd, log);
  }

  // 2. Controller instructions
  const ctrlFile = def.file;
  let block = tpl('controller-block.md').replace('{{IMPORT}}', def.import ?? (ctrlFile === 'AGENTS.md' ? '' : '@AGENTS.md'));
  if (ctrlFile !== 'CLAUDE.md') {
    // AGENTS.md / GEMINI.md are also read by workers: make the controller section conditional
    block = block.replace('## Conductor: you are the controller',
      `## Conductor: controller instructions (${def.label} only)\n\n` +
      '_Workers: ignore this section; follow your WORKER prompt. It applies only when the user runs you directly as the controller._');
  }
  mergeMarkedBlock(path.join(root, ctrlFile), block, '<!-- conductor:start -->', '<!-- conductor:end -->', log);

  // Antigravity reads GEMINI.md: make sure it also points at AGENTS.md
  const geminiMd = path.join(root, 'GEMINI.md');
  if (!fs.existsSync(geminiMd)) { fs.writeFileSync(geminiMd, '# Gemini instructions\n\n@./AGENTS.md\n'); log('added', 'GEMINI.md (imports AGENTS.md)'); }
  else if (!fs.readFileSync(geminiMd, 'utf8').includes('AGENTS.md')) { fs.appendFileSync(geminiMd, '\n@./AGENTS.md\n'); log('merged', 'GEMINI.md (imports AGENTS.md)'); }

  // 3. Slash commands for the controller
  const cmdDir = new URL('commands/', TPL);
  if (def.commands?.as === 'commands') {
    for (const f of fs.readdirSync(cmdDir).filter((x) => x.endsWith('.md')).sort()) writeOwned(root, `${def.commands.dir}/${f}`, fs.readFileSync(new URL(f, cmdDir), 'utf8'), log);
  } else if (def.commands?.as === 'skills') {
    // agy, Codex and OpenCode all load workspace skills from .agents/skills/ (checked against each tool): the
    // /conduct-* commands become skills there
    for (const s of commandSkills()) writeOwned(root, `${def.commands.dir}/${s.name}/SKILL.md`, s.content, log);
  }

  // 4. MCP registration (optional second interface next to the CLI)
  if (mcp) {
    const server = { command: 'conductor', args: ['mcp'] };
    const m = def.mcp || {};
    if (m.format === 'mcpServers') mergeJsonFile(root, m.file, (d) => { d.mcpServers ||= {}; d.mcpServers.conductor ||= server; }, log);
    if (m.format === 'opencode') mergeJsonFile(root, m.file, (d) => { d.$schema ||= 'https://opencode.ai/config.json'; d.mcp ||= {}; d.mcp.conductor ||= { type: 'local', command: ['conductor', 'mcp'], enabled: true }; }, log);
    // agy CLI reads MCP servers only from its own config (agy mcp add), not from the project: say how, don't edit it for the user
    if (m.register === 'agy' && !agyHasConductor()) notes.push('Antigravity: agy loads MCP servers from its own config, not from this project. Register conductor once (for all projects):\n    agy mcp add conductor conductor mcp\n  Then check with: agy mcp list');
    // Codex reads MCP servers only from ~/.codex/config.toml: say how, don't edit it for the user
    if (m.register === 'codex' && !codexHasConductor()) notes.push('Codex: Codex loads MCP servers from ~/.codex/config.toml, not from this project. Register conductor once (for all projects):\n    codex mcp add conductor -- conductor mcp\n  Then check with: codex mcp list');
    // VS Code (Copilot agent mode and other MCP extensions) reads .vscode/mcp.json: on request, or when the project already has a .vscode folder
    if (vscode ?? fs.existsSync(path.join(root, '.vscode'))) mergeJsonFile(root, '.vscode/mcp.json', (d) => { d.servers ||= {}; d.servers.conductor ||= { type: 'stdio', ...server }; }, log);
  }

  // 5. Project state
  const pcfg = projectConfigPath(root);
  if (!fs.existsSync(pcfg)) { writeJSON(pcfg, { controller }); log('added', `${PROJECT_DIRNAME}/config.json`); }
  else {
    const cur = readJSON(pcfg, {});
    if (cur.controller !== controller) { cur.controller = controller; writeJSON(pcfg, cur); log('updated', `${PROJECT_DIRNAME}/config.json (controller)`); } else log('kept', `${PROJECT_DIRNAME}/config.json`);
  }
  writeOwned(root, `${PROJECT_DIRNAME}/.gitignore`, 'runs/\n.env\n', log);
  writeOwned(root, `${PROJECT_DIRNAME}/ORCHESTRATOR.md`, tpl('ORCHESTRATOR.md'), log);
  copyIfMissing(root, 'docs/plan/_TEMPLATE.md', tpl('plan-template.md'), log);
  copyIfMissing(root, 'HANDOFF.md', tpl('HANDOFF.md'), log);
  copyIfMissing(root, 'docs/architecture.md', tpl('architecture.md'), log);

  // 6. Keep conductor's files out of git (unless --share): the ones it created, plus its folders and skills
  if (share) {
    if (removeBlock(root)) log('updated', '.gitignore (conductor block removed: its files can be committed)');
  } else {
    const entries = [...new Set([...readBlock(root), ...BASE_ENTRIES, ...CREATED_FILES.filter((f) => created.has(f))])];
    const r = writeBlock(root, entries);
    log(r, `.gitignore (conductor's files kept out of git${r === 'kept' ? '' : ': commit .gitignore'})`);
    const tracked = trackedEntries(root, entries);
    if (tracked.length) notes.push(`Already committed, so .gitignore won't hide them: ${tracked.join(', ')}\n  To stop tracking them (the files stay on disk): git rm -r --cached ${tracked.map((t) => t.replace(/\/$/, '')).join(' ')}`);
  }

  // 6b. Project rules (.conductor/rules) and the reviewer subagent, in the format this controller reads (Q8)
  for (const [what, p] of syncControllerFiles(root, controller)) log(what, p);

  // 7. Your skill library (global + this project's) into the folders every controller reads
  const sk = syncSkills(root);
  const n = sk.added.length + sk.updated.length;
  if (n || sk.removed.length) log('synced', `skills: ${n / 2} active → .claude/skills and .agents/skills${sk.removed.length ? `, ${sk.removed.length / 2} removed` : ''}`);
  for (const s of sk.skipped) notes.push(`Skill not synced: ${s}`);

  // no proof, no "done": without a verify command every write task ends "unverified" (exit 4)
  const configured = readJSON(pcfg, {}).settings?.verify || readJSON(GLOBAL_CONFIG, {}).settings?.verify;
  if (!configured && !detectVerify(root)) notes.push('No verify command found. Until there is one, code a worker writes ends as "unverified" (exit 4), because nothing proves it works.\n  Set it once:  conductor init --verify "npm test"   (any command that exits 0 when the project is healthy)');

  return { lines, notes };
}

/** Put `cmd` on the "Verify" line of an existing AGENTS.md (or add the line under section 1). */
function setVerifyLine(file, cmd, log) {
  const text = fs.readFileSync(file, 'utf8');
  const line = `- **Verify (must pass before any task is "done"):** \`${cmd}\``;
  const has = /^\s*-\s*\*\*Verify[^\n]*$/m, section = /(^## 1\.[^\n]*\n\n?)/m;
  const next = has.test(text) ? text.replace(has, line)
    : section.test(text) ? text.replace(section, `$1${line}\n`)
      : `${text.trimEnd()}\n\n${line}\n`;
  if (next === text) return log('kept', `AGENTS.md (Verify: ${cmd})`);
  fs.writeFileSync(file, next);
  log('updated', `AGENTS.md (Verify: ${cmd})`);
}

export function setupGlobal() {
  const lines = [];
  if (!fs.existsSync(GLOBAL_CONFIG)) {
    // keep it minimal so new built-in defaults still apply; the UI writes overrides here
    writeJSON(GLOBAL_CONFIG, { version: 1, controller: DEFAULT_CONFIG.controller });
    lines.push(`  added    ${GLOBAL_CONFIG}`);
  } else lines.push(`  kept     ${GLOBAL_CONFIG}`);
  if (!fs.existsSync(GLOBAL_SECRETS)) {
    fs.mkdirSync(path.dirname(GLOBAL_SECRETS), { recursive: true });
    fs.writeFileSync(GLOBAL_SECRETS, [
      '# conductor-ai API keys (KEY=value). Real environment variables take precedence.',
      '# This file is only readable by you (chmod 600). Never commit it.',
      '# GEMINI_API_KEY=        # https://aistudio.google.com/apikey (free tier)',
      '# OPENROUTER_API_KEY=    # https://openrouter.ai/keys (free ":free" models)',
      '# KILO_API_KEY=          # optional: kilo-free works without a key (https://app.kilo.ai)',
      '# OPENCODE_API_KEY=      # https://opencode.ai/console (OpenCode Zen API, paid credits)',
      '# CEREBRAS_API_KEY=      # https://cloud.cerebras.ai (free tier)',
      '# MISTRAL_API_KEY=       # https://console.mistral.ai (free Experiment plan, Codestral)',
      '# NVIDIA_API_KEY=        # https://build.nvidia.com (free developer access)',
      '# OPENAI_API_KEY=',
      '# MOONSHOT_API_KEY=      # Kimi API',
      '# ANTHROPIC_API_KEY=',
      '# DEEPSEEK_API_KEY=',
      '# GROQ_API_KEY=',
      '',
    ].join('\n'), { mode: 0o600 });
    lines.push(`  added    ${GLOBAL_SECRETS} (chmod 600)`);
  } else lines.push(`  kept     ${GLOBAL_SECRETS}`);
  return lines;
}
