#!/usr/bin/env node
// Writes docs/SURFACES.md from src/surfaces.js (V3). test/surfaces.test.js fails when the file is out of date.
import fs from 'node:fs';
import { surfacesMarkdown } from '../src/surfaces.js';

const out = new URL('../docs/SURFACES.md', import.meta.url);
fs.writeFileSync(out, surfacesMarkdown());
console.log(`wrote ${out.pathname}`);
