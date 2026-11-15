// CI only: turn the failing tests in a saved `npm test` output into GitHub annotations, so the failures can be read
// from the run page and the API without opening the log.
import fs from 'node:fs';
const out = fs.readFileSync(process.argv[2] || 'test-output.txt', 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const at = out.lastIndexOf('failing tests:');
const blocks = (at >= 0 ? out.slice(at) : out).split(/\n(?=test at )/).filter((b) => b.startsWith('test at '));
for (const b of blocks.slice(0, 10)) {
  const [head, ...rest] = b.split('\n');
  const msg = rest.join('\n').trim().split('\n').slice(0, 25).join('\n').slice(0, 3000);
  console.log(`::error title=${head.replace(/^test at /, '').replace(/[:,]/g, ' ')}::${msg.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
}
if (!blocks.length) console.log(`::error title=npm test::${out.split('\n').slice(-40).join('\n').replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
