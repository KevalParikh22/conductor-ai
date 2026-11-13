#!/usr/bin/env node
// Writes docs/CONTROLLERS.md from the controller registry (V6). test/controllerdefs.test.js fails when it is out of date.
import fs from 'node:fs';
import { controllersMarkdown } from '../src/controllers.js';

const out = new URL('../docs/CONTROLLERS.md', import.meta.url);
fs.writeFileSync(out, controllersMarkdown());
console.log(`wrote ${out.pathname}`);
