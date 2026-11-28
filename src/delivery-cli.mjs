import { handler } from './delivery-executor.mjs';

let bytes = 0;
const chunks = [];
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 512 * 1024) process.exit(2);
  chunks.push(chunk);
}
try { process.stdout.write(JSON.stringify(await handler(JSON.parse(Buffer.concat(chunks).toString('utf8'))))); }
catch { process.exitCode = 2; }
