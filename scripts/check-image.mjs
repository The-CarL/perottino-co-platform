import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hashPassword } from '../src/auth.mjs';

// Smoke an already-built image. Temporary containers have no host port or network access.
const image = process.argv[2];
if (!image || image.startsWith('-')) throw new Error('Usage: node scripts/check-image.mjs IMAGE');
const name = 'perottino-smoke-' + randomUUID();
const data = name + '-data';
const browserIpc = name + '-render';
const ipcDirectory = '/run/perottino-render';
const workerIpc = name + '-worker';
const workerDirectory = '/run/perottino-worker';
const password = randomBytes(32).toString('base64url');
const probe = readFileSync(new URL('./image-probe.mjs', import.meta.url));
const environment = {
  ...process.env, OWNER_USERNAME: 'ci-owner', OWNER_PASSWORD_HASH: await hashPassword(password),
  IMAGE_SMOKE_PASSWORD: password, PEROTTINO_BEDROCK_WORKER_TOKEN: randomBytes(32).toString('base64url'),
};
function docker(args, input) {
  const result = spawnSync('docker', args, {
    env: environment, input, stdio: ['pipe','pipe','pipe'], timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Docker ' + args[0] + ' failed. ' + result.stderr.toString().trim());
  return result.stdout.toString().trim();
}
const containers = new Set();
function start(suffix, args, cmd = []) {
  const task = name + '-' + suffix;
  docker(['run','--detach','--pull=never','--name',task,'--network','none', ...args, image, ...cmd]);
  containers.add(task);
  return task;
}
function check(task, phase) {
  const credentials = ['write','recover'].includes(phase) ? ['--env','IMAGE_SMOKE_PASSWORD'] : [];
  docker(['exec','--interactive',...credentials,task,'node','--input-type=module','-',phase],probe);
}
function stop(task) {
  docker(['stop','--time','10',task]);
  docker(['rm',task]);
  containers.delete(task);
}
const appEnvironment = ['--init','--memory','896m','--cpu-shares','384','--env','OWNER_USERNAME','--env','OWNER_PASSWORD_HASH',
  '--env','PEROTTINO_AGENT_MODE=local','--env','PUBLIC_ORIGIN=https://127.0.0.1:3000',
  '--mount','type=volume,source=' + data + ',target=/var/lib/perottino',
  '--mount','type=volume,source=' + browserIpc + ',target=' + ipcDirectory + ',readonly',
  '--env','PEROTTINO_BROWSER_RENDER_SOCKET=' + ipcDirectory + '/renderer.sock',
  '--mount','type=volume,source=' + workerIpc + ',target=' + workerDirectory + ',readonly',
  '--env','PEROTTINO_BEDROCK_WORKER_TOKEN','--env','PEROTTINO_BEDROCK_WORKER_SOCKET=' + workerDirectory + '/decision.sock'];
const volumes = [];
try {
  for (const volume of [data, browserIpc, workerIpc]) {
    docker(['volume','create',volume]);
    volumes.push(volume);
  }
  const renderer = start('renderer', ['--init','--read-only','--memory','640m','--cpu-shares','512','--cap-drop=ALL','--security-opt','no-new-privileges',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount','type=volume,source=' + browserIpc + ',target=' + ipcDirectory,
    '--env','PEROTTINO_BROWSER_RENDER_SOCKET=' + ipcDirectory + '/renderer.sock',
    '--env','PEROTTINO_BROWSER_EXTERNAL_SANDBOX=1'],['node','src/renderer.mjs']);
  check(renderer,'renderer');
  const worker = start('inference', [
    '--env','PEROTTINO_BEDROCK_WORKER_TOKEN','--env','PEROTTINO_BEDROCK_WORKER_SOCKET=' + workerDirectory + '/decision.sock',
    '--mount','type=volume,source=' + workerIpc + ',target=' + workerDirectory,
    '--init','--read-only','--cap-drop=ALL','--memory','1280m','--cpu-shares','1024',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777'],['node','src/agent.mjs','--bedrock-worker']);
  const first = start('first',appEnvironment);
  check(first,'worker');
  check(first,'write');
  stop(first);
  const fresh = start('fresh',appEnvironment);
  check(fresh,'recover');
  stop(fresh);
  stop(worker);
  stop(renderer);
  console.log('Image passed owner sign-in, chat, memory, cold recovery, Chromium rendering and worker authentication.');
} finally {
  // Only these uniquely named local test containers and volume are owned by this run.
  for (const task of containers) docker(['rm','--force',task]);
  for (const volume of volumes) docker(['volume','rm',volume]);
}
