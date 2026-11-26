import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Boot the exact ECS command and exercise HTTP -> HTTPS with ACME and real DNS unreachable.
const [image, filename] = process.argv.slice(2);
if (!image || image.startsWith('-') || !filename) throw new Error('Usage: node scripts/check-proxy.mjs IMAGE HOSTED_TEMPLATE');
const {Resources} = JSON.parse(readFileSync(filename,'utf8'));
const edge = Resources.ConsoleTask.Properties.ContainerDefinitions.find(container => container.Name === 'edge');
assert.deepEqual(edge.EntryPoint,['caddy']);
assert.equal(edge.Command[0],'reverse-proxy');
const host = edge.Command[edge.Command.indexOf('--from') + 1];
assert.match(host,/^[A-Za-z0-9.-]+$/);
const name = 'perottino-proxy-smoke-' + randomUUID();
function run(args,input) {
  return spawnSync('docker',args,{input,encoding:'utf8',timeout:20_000});
}
const result = run(['run','--detach','--pull=never','--network','none','--name',name,'--memory',edge.Memory + 'm','--cpu-shares',String(edge.Cpu),
  '--entrypoint',edge.EntryPoint[0],image,...edge.Command]);
if (result.status !== 0) throw new Error(result.stderr || String(result.error));
try {
  const get = ['GET /chat HTTP/1.1','Host: ' + host,'Connection: close','',''].join('\r\n');
  let reply = '';
  for (let i = 0; i < 30; i++) {
    reply = run(['exec','--interactive',name,'nc','-w','2','127.0.0.1','80'],get).stdout || '';
    if (reply.startsWith('HTTP/')) break;
    await delay(200);
  }
  assert.match(reply,/^HTTP\/1\.[01] 308 /);
  assert.ok(reply.toLowerCase().includes('\r\nlocation: https://' + host.toLowerCase() + '/chat\r\n'));
  console.log('The packaged proxy runs the synthesized command and redirects /chat to the configured HTTPS hostname.');
} finally {
  const removed = run(['rm','--force','--volumes',name]);
  if (removed.status !== 0) throw new Error(removed.stderr || 'Could not remove the temporary proxy.');
}
