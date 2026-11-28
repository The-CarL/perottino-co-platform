import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { synthFoundation } from './foundation.mjs';

const { values } = parseArgs({ options: {
  provenance: { type: 'string' }, outdir: { type: 'string', default: 'cdk.out' },
} });
const input = values.provenance ?? new URL('./example-provenance.json', import.meta.url);
const stack = synthFoundation(JSON.parse(readFileSync(input, 'utf8')), resolve(values.outdir));
console.log((values.provenance ? 'Foundation template' : 'Example foundation template') + ' written to ' + stack.templateFullPath);
