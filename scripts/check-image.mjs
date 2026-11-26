import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [worker, lambda, database] = process.argv.slice(2);
if (![worker,lambda,database].every(s => s && !s.startsWith('-'))) {
  throw new Error('Usage: node scripts/check-image.mjs WORKER_IMAGE LAMBDA_IMAGE DYNAMODB_LOCAL_IMAGE');
}
const probe = readFileSync(new URL('./image-probe.mjs', import.meta.url),'utf8');
const prefix = 'perottino-smoke-' + randomUUID();
const tasks = new Set();
function docker(args) {
  const result = spawnSync('docker',args,{encoding:'utf8',timeout:90_000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Docker ' + args[0] + ' failed: ' + result.stderr.trim());
  return result.stdout.trim();
}
function start(label,args) {
  const name = prefix + '-' + label;
  docker(['run','--detach','--pull=never','--name',name,...args]);
  tasks.add(name);
  return name;
}
function stop(name) {
  docker(['rm','--force','--volumes',name]);
  tasks.delete(name);
}
try {
  // All test containers share only this networkless loopback namespace. No AWS endpoints are reachable.
  const db = start('ddb',['--network','none',database,'-jar','DynamoDBLocal.jar','-inMemory','-sharedDb']);
  const common = ['--network','container:' + db,'--env','AWS_REGION=us-east-1','--env','AWS_ACCESS_KEY_ID=localtest',
    '--env','AWS_SECRET_ACCESS_KEY=synthetic','--env','AWS_EC2_METADATA_DISABLED=true','--env','PEROTTINO_STATE_TABLE=ImageSmoke',
    '--env','AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000','--env','AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:8099'];
  const lambdaLimits = ['--user','1000:1000','--memory','512m','--read-only','--tmpfs','/tmp:rw,mode=1777'];
  const api = start('api',[...common,...lambdaLimits,'--env','PEROTTINO_OWNER_SECRET_ARN=synthetic-owner',lambda]);
  docker(['exec','--detach',api,'node','--input-type=module','-e',probe,'secret-fixture']);
  const {turnId, marker} = JSON.parse(docker(['exec',api,'node','--input-type=module','-e',probe,'api']));
  if (!/^[a-f0-9]{64}$/.test(turnId)) throw new Error('The API did not return a durable turn ID');
  docker(['run','--rm','--pull=never',...common,'--cpus','0.25','--memory','1g','--read-only','--tmpfs','/tmp:rw,mode=1777','--cap-drop=ALL',
    '--env','TURN_ID=' + turnId,'--entrypoint','node',worker,'--input-type=module','-e',probe,'employee']);
  // First run handles the explicit remember command. A replacement task then replays the same wake.
  const employeeTask = ['run','--rm','--pull=never',...common,'--cpus','0.25','--memory','1g',
    '--read-only','--tmpfs','/tmp:rw,mode=1777','--cap-drop=ALL','--env','AGENT_ID=ceo','--env','TURN_ID=' + turnId,worker];
  docker(employeeTask);
  docker(employeeTask);
  docker(['exec',api,'node','--input-type=module','-e',probe,'recover']);
  stop(api);
  for (const phase of ['handler','admit','terminal']) {
    const fn = start(phase,[...common,...lambdaLimits,'--env','AWS_ENDPOINT_URL_SFN=http://127.0.0.1:8100',
      '--env','PEROTTINO_STATE_MACHINE_ARN=arn:aws:states:us-east-1:111111111111:stateMachine:ImageSmoke',lambda,'src/dispatch.' + phase]);
    docker(['exec','--env','TURN_ID=' + turnId,'--env','IMAGE_SMOKE_MARKER=' + JSON.stringify(marker),
      fn,'node','--input-type=module','-e',probe,phase]);
    stop(fn);
  }
  console.log('Packaged HTTP API, Streams dispatch, admission, terminal handler, one-shot employee, replay and memory passed.');
} finally {
  for (const name of [...tasks].reverse()) stop(name);
}
