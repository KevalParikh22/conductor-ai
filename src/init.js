// `conductor init`: add conductor to a project for the chosen controller. Never overwrites user files.
// `conductor setup`: first-time global setup (~/.config/conductor).
import fs from 'node:fs';
import path from 'node:path';
import { CONTROLLERS, DEFAULT_CONFIG } from './presets.js';
import { GLOBAL_CONFIG, GLOBAL_SECRETS, PROJECT_DIRNAME, projectConfigPath } from './config.js';
import { readJSON, writeJSON } from './util.js';

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

const tomlString = (s) => '"""\n' + s.replaceAll('\\', '\\\\').replaceAll('"""', '\\"\\"\\"') + '\n"""';

export function initProject(root, { controller = 'claude-code', mcp = true } = {}) {
  if (!CONTROLLERS[controller]) throw new Error(`unknown controller "${controller}". Options: ${Object.keys(CONTROLLERS).join(', ')}`);
  const lines = [];
  const log = (what, p) => lines.push(`  ${what.padEnd(8)} ${p}`);
  const notes = [];

  // 1. AGENTS.md: full template if new, otherwise append just the rules/protocol block
  const agentsPath = path.join(root, 'AGENTS.md');
  const agentsTpl = tpl('AGENTS.md');
  if (!fs.existsSync(agentsPath)) { fs.writeFileSync(agentsPath, agentsTpl); log('added', 'AGENTS.md   ← fill in section 1 (project facts + Verify command)'); }
  else {
    const s = '<!-- conductor:rules:start -->', e = '<!-- conductor:rules:end -->';
    mergeMarkedBlock(agentsPath, agentsTpl.slice(agentsTpl.indexOf(s), agentsTpl.indexOf(e) + e.length), s, e, log);
  }

  // 2. Controller instructions
  const ctrlFile = CONTROLLERS[controller].file;
  const imports = { 'CLAUDE.md': '@AGENTS.md', 'GEMINI.md': '@./AGENTS.md', 'AGENTS.md': '' };
  let block = tpl('controller-block.md').replace('{{IMPORT}}', imports[ctrlFile]);
  if (ctrlFile === 'AGENTS.md') {
    // AGENTS.md is also read by workers: make the controller section conditional
    block = block.replace('## Conductor: you are the controller',
      `## Conductor: controller instructions (${CONTROLLERS[controller].label} only)\n\n` +
      '_Workers: ignore this section; follow your WORKER prompt. It applies only when the user runs you directly as the controller._');
  }
  mergeMarkedBlock(path.join(root, ctrlFile), block, '<!-- conductor:start -->', '<!-- conductor:end -->', log);

  // Gemini reads GEMINI.md by default: make sure it also gets AGENTS.md when used as a worker
  const geminiMd = path.join(root, 'GEMINI.md');
  if (!fs.existsSync(geminiMd)) { fs.writeFileSync(geminiMd, '# Gemini instructions\n\n@./AGENTS.md\n'); log('added', 'GEMINI.md (imports AGENTS.md)'); }
  else if (!fs.readFileSync(geminiMd, 'utf8').includes('AGENTS.md')) { fs.appendFileSync(geminiMd, '\n@./AGENTS.md\n'); log('merged', 'GEMINI.md (imports AGENTS.md)'); }

  // 3. Slash commands for the controller
  const cmdDir = new URL('commands/', TPL);
  for (const f of fs.readdirSync(cmdDir).filter((x) => x.endsWith('.md')).sort()) {
    const src = fs.readFileSync(new URL(f, cmdDir), 'utf8');
    if (controller === 'claude-code') writeOwned(root, `.claude/commands/${f}`, src, log);
    if (controller === 'gemini-cli') {
      const { meta, body } = parseCommand(src);
      const prompt = body.replaceAll('$ARGUMENTS', '{{args}}').replaceAll('.claude/commands/conduct-build.md', '.gemini/commands/conduct-build.toml');
      writeOwned(root, `.gemini/commands/${f.replace(/\.md$/, '.toml')}`, `description = ${JSON.stringify(meta.description || '')}\nprompt = ${tomlString(prompt)}\n`, log);
    }
  }
  if (controller === 'codex-cli' || controller === 'opencode') {
    writeOwned(root, '.conductor/commands/README.md', '# Controller prompts\n\nThese prompts mirror the Claude `/conduct-*` commands. Paste or reference them in your controller.\n', log);
    for (const f of fs.readdirSync(cmdDir).filter((x) => x.endsWith('.md'))) {
      writeOwned(root, `.conductor/commands/${f}`, parseCommand(fs.readFileSync(new URL(f, cmdDir), 'utf8')).body + '\n', log);
    }
  }

  // 4. MCP registration (optional second interface next to the CLI)
  if (mcp) {
    const server = { command: 'conductor', args: ['mcp'] };
    if (controller === 'claude-code') mergeJsonFile(root, '.mcp.json', (d) => { d.mcpServers ||= {}; d.mcpServers.conductor ||= server; }, log);
    if (controller === 'gemini-cli') mergeJsonFile(root, '.gemini/settings.json', (d) => { d.mcpServers ||= {}; d.mcpServers.conductor ||= { ...server, timeout: 1800000 }; }, log);
    if (controller === 'opencode') mergeJsonFile(root, 'opencode.json', (d) => { d.$schema ||= 'https://opencode.ai/config.json'; d.mcp ||= {}; d.mcp.conductor ||= { type: 'local', command: ['conductor', 'mcp'], enabled: true }; }, log);
    if (controller === 'codex-cli') notes.push('Codex: add to ~/.codex/config.toml:\n    [mcp_servers.conductor]\n    command = "conductor"\n    args = ["mcp"]');
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

  return { lines, notes };
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
