import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { synthHosted } from './hosted.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' }, provenance: { type: 'string' },
  outdir: { type: 'string', default: 'cdk.hosted.out' } } });
if (Boolean(values.config) !== Boolean(values.provenance)) throw new Error('Supply both private config and provenance');
const read = (file, sample) => JSON.parse(readFileSync(file ?? new URL(sample, import.meta.url), 'utf8'));
const stack = synthHosted(read(values.config, './example-hosted.json'),
  read(values.provenance, './example-provenance.json'), resolve(values.outdir));
// Keep the staged S3 template deterministic and record the digest of these exact bytes.
writeFileSync(stack.templateFullPath, JSON.stringify(stack.template) + '\n');
console.log((values.config ? 'Hosted template' : 'Example hosted template') + ' written to ' + stack.templateFullPath);
