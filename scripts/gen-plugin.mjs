// Writes the Claude Code / Antigravity plugin that lives in this repo: skills from the /conduct-* command templates,
// the manifest version from package.json. Run after changing templates/commands (CI checks they're in sync).
import fs from 'node:fs';
import path from 'node:path';
import { commandSkills } from '../src/init.js';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const skillsDir = path.join(root, 'skills');
fs.rmSync(skillsDir, { recursive: true, force: true });
for (const s of commandSkills({ plugin: true })) {
  fs.mkdirSync(path.join(skillsDir, s.name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, s.name, 'SKILL.md'), s.content);
}

const manifestFile = path.join(root, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`plugin: ${commandSkills().length} skills, version ${pkg.version}`);
