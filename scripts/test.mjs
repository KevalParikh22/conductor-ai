// npm test: node --test on test/*.test.js. The file list is built here because Node 20 doesn't expand globs itself,
// and Windows shells don't either (macOS and Linux shells did it for us).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).sort().map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
