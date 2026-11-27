import assert from 'node:assert/strict';
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
function docker(args, timeout = 110_000) {
  const result = spawnSync('docker',args,{encoding:'utf8',timeout});
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
function runProbe(container, phase) {
  return docker(['exec',container,'node','--input-type=module','-e',probe,phase]);
}

try {
  // The only network available to every tested process is this private loopback.
  const db = start('ddb',['--network','none',database,'-jar','DynamoDBLocal.jar','-inMemory','-sharedDb']);
  const common = ['--network','container:' + db,'--env','AWS_REGION=us-east-1','--env','AWS_ACCESS_KEY_ID=localtest',
    '--env','AWS_SECRET_ACCESS_KEY=synthetic','--env','AWS_EC2_METADATA_DISABLED=true','--env','PEROTTINO_STATE_TABLE=ImageSmoke','--env','PEROTTINO_RESIDENT=1',
    '--env','AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000','--env','AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:8099'];
  const lambdaLimits = ['--user','1000:1000','--memory','512m','--read-only','--tmpfs','/tmp:rw,mode=1777'];
  const api = start('api',[...common,...lambdaLimits,'--env','PEROTTINO_OWNER_SECRET_ARN=synthetic-owner',lambda]);
  docker(['exec','--detach',api,'node','--input-type=module','-e',probe,'fixtures']);
  const generation = runProbe(api,'setup');
  assert.match(generation,/^\d+$/);
  const employee = start('ceo',[...common,'--cpus','0.25','--memory','1g',
    '--read-only','--tmpfs','/tmp:rw,mode=1777','--cap-drop=ALL','--security-opt','no-new-privileges',
    '--env','PEROTTINO_COMPANY_GATE=1','--env','PEROTTINO_COMPANY_EPOCH=1','--env','AGENT_ID=ceo','--env','EMPLOYEE_GENERATION=' + generation,'--env','NODE_ENV=test',
    '--env','PEROTTINO_EMPLOYEE_CAPABILITY=' + 'a'.repeat(64),'--env','PEROTTINO_FACTORY_MANAGER_ARN=arn:aws:lambda:us-east-1:111111111111:function:test-manager',
    '--env','ECS_CONTAINER_METADATA_URI_V4=http://127.0.0.1:8099/v4/employee',worker]);
  try {
    runProbe(employee,'native');
    const processBefore = docker(['inspect','--format','{{.State.Pid}} {{.State.StartedAt}}',employee]);
    runProbe(api,'secondMessage');
    runProbe(api,'verify');
    assert.equal(docker(['inspect','--format','{{.State.Pid}} {{.State.StartedAt}}',employee]), processBefore,
      'Both replies must come from the same running container');
    runProbe(api,'pause');
    assert.equal(docker(['wait',employee],100_000), '0', 'Paused resident must exit cleanly');
  } catch (error) {
    throw new Error(error.message + '\nResident: ' + docker(['logs','--tail','20',employee]),{cause:error});
  }
  // This worker also executes bounded goal steps with a deterministic model callback.
  docker(['run','--rm','--pull=never',...common,'--cpus','0.25','--memory','1g','--cap-drop=ALL',
    '--security-opt','no-new-privileges','--read-only','--tmpfs','/tmp:rw,mode=1777',
    '--env','PEROTTINO_COMPANY_GATE=1','--env','PEROTTINO_COMPANY_EPOCH=1',
    '--entrypoint','node',worker,'--input-type=module','-e',probe,'goals']);
  stop(api);
  const factoryEnv = ['--env','PEROTTINO_CLUSTER_ARN=arn:aws:ecs:us-east-1:111111111111:cluster/resident',
    '--env','PEROTTINO_TASK_DEFINITION_ARN=arn:aws:ecs:us-east-1:111111111111:task-definition/worker:1',
    '--env','PEROTTINO_PUBLIC_SUBNET_IDS=subnet-test','--env','PEROTTINO_SECURITY_GROUP_ID=sg-test','--env','PEROTTINO_EMPLOYEE_LIMIT=3',
    '--env','PEROTTINO_MAIL_DOMAIN=company.example.com','--env','PEROTTINO_MAIL_TOPIC_ARN=arn:aws:sns:us-east-1:111111111111:test-mail'];
  for (const [phase,handler] of Object.entries({factory:'src/factory.handler',owner:'src/factory.owner',manager:'src/factory.manager',
    mail:'src/email-ingress.handler'})) {
    const fn = start(phase,[...common,...lambdaLimits,...factoryEnv,lambda,handler]);
    try { runProbe(fn,phase); } finally { stop(fn); }
  }
  console.log('Packaged API, two successive messages served by one resident, source memory, goal checkpoints, pause, factory handlers and mail ingress passed.');
} finally {
  for (const name of [...tasks].reverse()) stop(name);
}
