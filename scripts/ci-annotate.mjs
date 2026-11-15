// CI only: turn the failing tests in a saved `npm test` output (TAP, as node --test prints when piped) into GitHub
// annotations, so the failures can be read from the run page and the API without opening the log.
import fs from 'node:fs';
const lines = fs.readFileSync(process.argv[2] || 'test-output.txt', 'utf8').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').split('\n');
const esc = (t) => t.replace(/%/g, '%25').replace(/\n/g, '%0A');
let n = 0;
// GitHub keeps 10 annotations of each level per step: errors, then warnings, then notices (30 failures)
const LEVEL = ['error', 'warning', 'notice'];
for (let i = 0; i < lines.length && n < 30; i++) {
  const m = lines[i].match(/^\s*not ok \d+ - (.+)$/);
  if (!m) continue;
  const body = [];
  for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]) && body.length < 30; j++) body.push(lines[j]);
  if (body.some((l) => /failureType: 'subtestsFailed'/.test(l))) continue; // a parent: its failing child is listed
  console.log(`::${LEVEL[Math.floor(n / 10)]} title=${m[1].replace(/[:,]/g, ' ').slice(0, 200)}::${esc(body.join('\n').slice(0, 3000))}`);
  n++;
}
if (!n) console.log(`::error title=npm test::${esc(lines.slice(-40).join('\n'))}`);
