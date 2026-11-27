import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ECSClient, RunTaskCommand, StopTaskCommand, DescribeTasksCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCompanyService } from './company-service.mjs';
import { makeDynamoRecords } from './foundation-records.mjs';
import { withSpan, flushTelemetry, operationFailure } from './telemetry.mjs';
import { createCloudStore } from './cloud-store.mjs';
import { hostedAdapters } from './company-adapters.mjs';
import { reconcileInfrastructure } from './company-infrastructure.mjs';
import { expirePreviews } from './company-deployments.mjs';
import { createCompanyFiles } from './company-files.mjs';
import { createFactoryState } from './factory-state.mjs';
import { isValidEmployeeLimit, maxCompanyEmployees } from './headcount.mjs';

const maxFailures = 5;
const stableRuntime = 10 * 60_000;
const replayWindow = 45 * 60_000;
const maxPage = 12;
const hash = value => createHash('sha256').update(value).digest();
const idFormat = /^[a-zA-Z0-9_-]{1,120}$/;
const requestFormat = /^[a-zA-Z0-9._:-]{1,160}$/;
const allowed = company => company?.enabled && !company.suspended;
function reject(status, code) { throw Object.assign(new Error(code), { status, code }); }
function publicEmployee({ id, name, handle, role, managerId, desiredState, canHire }) {
  return { id, name, handle, role, managerId, desiredState, canHire };
}

function generatedIdentity(caller, request, candidate) {
  const first = ['Ada', 'Inez', 'Jules', 'Kai', 'Lea', 'Noor', 'Remy', 'Sora'];
  const last = ['Bell', 'Costa', 'Finch', 'Lin', 'Marin', 'Park', 'Reed', 'Silva'];
  const digest = hash(JSON.stringify([caller, request, candidate]));
  const name = first[digest[0] % first.length] + ' ' + last[digest[1] % last.length];
  // Preserve an ordinary first choice. The deterministic suffix also works when the
  // short name was reserved by a previous employee, including one who has left.
  const suffix = candidate ? ' ' + digest.toString('hex', 2, 5) : '';
  return { name: name + suffix, handle: (name + suffix).toLowerCase().replaceAll(' ', '-') };
}

function deployment(config) {
  const { clusterArn, taskDefinitionArn, subnets, securityGroupId } = config;
  if (!clusterArn || !taskDefinitionArn || !subnets?.length || !securityGroupId) throw new Error('Missing resident launch settings');
  const revision = hash(JSON.stringify([clusterArn, taskDefinitionArn, subnets, securityGroupId])).toString('hex');
  return { revision, clusterArn, taskDefinitionArn, subnets, securityGroupId };
}

async function respondToCloudFormation(event, result) {
  const url = new URL(event.ResponseURL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.amazonaws.com') || !url.hostname.includes('s3')
      || url.username || url.password) throw new Error('Invalid CloudFormation response destination');
  const body = JSON.stringify(result);
  const response = await fetch(url, { method: 'PUT', body, headers: { 'content-type': '' },
    redirect: 'error', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error('CloudFormation response delivery failed');
}

export function createEmployeeFactory({ store, state, ecs, config, recordsFor, adapters, now = Date.now, sleep = delay, respond = respondToCloudFormation }) {
  const call = command => {
    const send = () => ecs.send(command,{abortSignal:AbortSignal.timeout(7_000)});
    if (command instanceof RunTaskCommand || command instanceof StopTaskCommand) return withSpan('factory.reconcile',
      {action:command instanceof RunTaskCommand ? 'create' : 'pause'},send);
    return send();
  };
  const describe = async arns => {
    const result = await call(new DescribeTasksCommand({ cluster: config.clusterArn, tasks: arns }));
    if (result.failures?.some(failure => failure.reason !== 'MISSING')) throw new Error('ECS task status could not be verified');
    return result.tasks ?? [];
  };
  async function stop(arn) {
    try { await call(new StopTaskCommand({ cluster: config.clusterArn, task: arn, reason: 'Employee lifecycle change' })); }
    catch (error) {
      // ECS may forget an old stopped task. Do not suppress permission/network failures.
      if (error.name !== 'ClusterNotFoundException' && error.name !== 'ResourceNotFoundException') throw error;
    }
  }

  async function reconcile(id, { stoppedArn, replace = true, allowLaunch = true, onLaunch } = {}) {
    const lock = await state.lock(id, now());
    if (!lock) return 'busy';
    let empty = !lock.run, seat = lock.seat;
    async function save(value) {
      const releaseSeat = seat && (!value || !value.arn && !value.capability);
      await state.save(id, lock.lease, value, releaseSeat);
      if (releaseSeat) seat = false;
      empty = !value;
    }
    try {
      const [company, employee] = await Promise.all([state.company(), store.employee(id)]);
      if (!employee) return lock.run || seat ? 'unresolved' : 'absent';
      let run = lock.run;
      const active = allowed(company) && employee.desiredState === 'active';
      const revision = company?.deployment?.revision;
      const current = run?.generation === employee.generation && run?.revision === revision && run?.epoch === company?.epoch;
      const arn = run?.arn ?? employee.taskArn;
      if (stoppedArn && stoppedArn !== arn) return 'stale';

      async function failedAttempt(previous, definitive) {
        const failures = (previous.failures ?? 0) + 1;
        const stage = failures >= maxFailures ? 'blocked' : definitive ? 'backoff' : 'launching';
        const next = { ...previous, failures, stage, retryAt: now() + Math.min(900_000, 15_000 * 2 ** (failures - 1)) };
        if (definitive) { delete next.arn; delete next.capability; delete next.healthySince; }
        await save(next);
        return stage;
      }

      if (arn) {
        const task = stoppedArn ? { lastStatus: 'STOPPED' } : (await describe([arn]))[0];
        // ECS is eventually consistent immediately after RunTask.
        if (!task && run && now() - run.startedAt < 120_000) return active && current ? 'starting' : 'settling';
        if (!task || task.lastStatus === 'STOPPED') {
          if (employee.taskArn === arn) await store.clearEmployeeTask({ agentId: id,
            generation: employee.taskGeneration ?? run?.generation, taskArn: arn });
          if (active && current && run.stage !== 'stopping') {
            return await failedAttempt({ ...run, failures: run.healthySince && now() - run.healthySince >= stableRuntime ? 0 : run.failures }, true);
          }
          await save(null);
          run = null;
        } else if (!active || !current || run.stage === 'stopping') {
          if (active && !current && !replace) return 'deferred';
          if (task.desiredStatus !== 'STOPPED') await stop(arn);
          await save({ ...run, arn, stage: 'stopping', generation: run?.generation ?? employee.taskGeneration ?? employee.generation });
          return 'stopping';
        } else {
          if (employee.taskArn !== arn && !await store.bindEmployeeTask({ agentId: id, generation: employee.generation, taskArn: arn })) {
            await stop(arn);
            await save({ ...run, stage: 'stopping' });
            return 'stopping';
          }
          if (task.lastStatus === 'RUNNING' && !run.healthySince) await save({ ...run, healthySince: now() });
          return task.lastStatus === 'RUNNING' ? 'running' : 'starting';
        }
      }

      if (run?.token && !run.arn && (!current || !active || run.stage === 'blocked' || now() - run.startedAt >= replayWindow)) {
        // Reconcile an uncertain RunTask by its private launch ID. Never replay an
        // old client token past ECS's deduplication window or start after a pause.
        if (['launching', 'blocked'].includes(run.stage) && run.capability) {
          const found = await call(new ListTasksCommand({ cluster: config.clusterArn, startedBy: run.token, maxResults: 10 }));
          const foundArn = found.taskArns?.[0];
          if (foundArn) {
            await save({ ...run, arn: foundArn, stage: active && current ? 'started' : 'stopping' });
            if (!active || !current) await stop(foundArn);
            else if (!await store.bindEmployeeTask({ agentId: id, generation: employee.generation, taskArn: foundArn })) await stop(foundArn);
            return active && current ? 'starting' : 'stopping';
          }
          if (active && current) { await save({ ...run, stage: 'blocked' }); return 'blocked'; }
          if (now() - run.startedAt < 120_000) return 'settling';
        }
        if (!current || !active) { await save(null); run = null; }
      }
      if (!active) return 'inactive';
      if (run?.stage === 'blocked') return 'blocked';
      if (run?.retryAt > now()) return 'backoff';
      if (!allowLaunch) return 'deferred';
      if (!run || run.stage === 'backoff') {
        run = { generation: employee.generation, revision, epoch: company.epoch, token: randomUUID(), capability: randomBytes(32).toString('base64url'),
          startedAt: now(), failures: run?.failures ?? 0, stage: 'launching' };
      }
      // The disabled-company transaction fences every launch, including replays of
      // ambiguous calls. The durable intent exists before ECS can see the request.
      if (!await state.reserve(id, lock.lease, run, company, seat)) return 'deferred';
      empty = false; seat = true;
      const params = company.deployment;
      const identity = { AGENT_ID: id, EMPLOYEE_GENERATION: String(run.generation), PEROTTINO_COMPANY_EPOCH: String(run.epoch),
        PEROTTINO_EMPLOYEE_CAPABILITY: run.capability };
      let result;
      try {
        onLaunch?.();
        result = await call(new RunTaskCommand({ cluster: params.clusterArn, taskDefinition: params.taskDefinitionArn,
          launchType: 'FARGATE', platformVersion: '1.4.0', count: 1, startedBy: run.token, clientToken: run.token,
          group: 'employee-' + id, enableECSManagedTags: true, propagateTags: 'TASK_DEFINITION',
          networkConfiguration: { awsvpcConfiguration: { subnets: params.subnets, securityGroups: [params.securityGroupId], assignPublicIp: 'ENABLED' } },
          overrides: { containerOverrides: [{ name: 'worker', environment: Object.entries(identity).map(([name, value]) => ({ name, value })) }] } }));
      } catch {
        // A timeout can follow successful placement. Preserve every argument and retry
        // the same token; no secret-bearing request or raw SDK exception is logged.
        return await failedAttempt(run, false);
      }
      const newArn = result.tasks?.[0]?.taskArn;
      if (!newArn) return await failedAttempt(run, true);
      await save({ ...run, arn: newArn, stage: 'started' });
      const fresh = await state.company();
      if (!allowed(fresh) || fresh.deployment.revision !== revision || fresh.epoch !== run.epoch ||
          !await store.bindEmployeeTask({ agentId: id, generation: run.generation, taskArn: newArn })) {
        await stop(newArn);
        await save({ ...run, arn: newArn, stage: 'stopping' });
        return 'stopping';
      }
      return 'starting';
    } finally { await state.unlock(id, lock.lease, empty); }
  }

  async function repair() {
    const company = await state.company();
    if (!company) return;
    if(adapters && recordsFor) {
      const records=recordsFor();
      await expirePreviews(records);
      if(adapters.infrastructure) await reconcileInfrastructure(records,adapters.infrastructure);
      if(adapters.blobs) await createCompanyFiles({records,blobs:adapters.blobs,employee:id=>store.employee(id)}).repair();
    }
    const page = await store.employeePage({ cursor: company.cursor, limit: maxPage });
    let replace = true, launches = 0;
    for (const employee of page.employees) {
      const result = await reconcile(employee.id, { replace, allowLaunch: launches < 3, onLaunch: () => { launches++; } });
      if (result === 'stopping') replace = false;
    }
    await state.advance(company, page.cursor);
  }

  // Use live cluster inventory to drain even when there are many historical fired
  // employees. Both the employee group and the factory's launch ID/ARN must match.
  async function drain({ confirm = false, deadline = Date.now() + 180_000 } = {}) {
    const beforeDeadline = () => {
      if (Date.now() >= deadline) throw new Error('Employee shutdown has outstanding requests');
    };
    // A pause can acknowledge scheduled stops. Stack deletion must observe all
    // accepted launches settled, since the event rule and factory will disappear.
    for (let round = 0; round < 26; round++) {
      let pending = false, cursor;
      do {
        beforeDeadline();
        const page = await state.runPage(cursor);
        for (const id of page.ids) {
          beforeDeadline();
          const status = await reconcile(id, { allowLaunch: false });
          if (status !== 'inactive' && status !== 'absent') pending = true;
        }
        cursor = page.cursor;
      } while (cursor);
      if (!allowed(await state.company()) && await stopInventory(beforeDeadline)) pending = true;
      if (!confirm || !pending) return;
      await sleep(5_000);
    }
    throw new Error('Employee shutdown is not yet verified');
  }
  async function stopInventory(beforeDeadline) {
    let pending = false;
    let nextToken;
    do {
      beforeDeadline();
      let response;
      try { response = await call(new ListTasksCommand({ cluster: config.clusterArn, maxResults: 100, nextToken })); }
      catch (error) { if (error.name === 'ClusterNotFoundException') return false; throw error; }
      const tasks = response.taskArns?.length ? await describe(response.taskArns) : [];
      if (tasks.length !== (response.taskArns?.length ?? 0)) pending = true;
      for (const task of tasks) {
        beforeDeadline();
        if (task.lastStatus === 'STOPPED' || !task.group?.startsWith('employee-')) continue;
        const id = task.group.slice('employee-'.length);
        if (!idFormat.test(id)) continue;
        const run = await state.run(id);
        if (run && (run.arn === task.taskArn || run.token === task.startedBy)) {
          pending = true;
          if (task.desiredStatus !== 'STOPPED') await stop(task.taskArn);
        } else if (task.taskDefinitionArn?.split(':').slice(0, -1).join(':') === config.taskDefinitionArn.split(':').slice(0, -1).join(':')) {
          // Never stop a task of uncertain ownership or declare deletion completed
          // while that task may belong to this deployment.
          pending = true;
        }
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return pending;
  }

  async function custom(event, context) {
    const result = { StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId,
      PhysicalResourceId: event.PhysicalResourceId ?? event.StackId + '/' + event.LogicalResourceId, NoEcho: false };
    try {
      if (!['Create', 'Update', 'Delete'].includes(event.RequestType)) throw new Error('Unknown CloudFormation operation');
      const enabled = event.RequestType !== 'Delete';
      if (enabled && event.ResourceProperties?.TaskDefinitionArn !== config.taskDefinitionArn) throw new Error('Task definition mismatch');
      const company = await state.configure({ stackId: event.StackId, requestId: event.RequestId, enabled,
        create: event.RequestType === 'Create', deployment: enabled ? deployment(config) : undefined,
        employeeLimit: enabled ? config.employeeLimit : undefined });
      if (!enabled && company && !company.enabled) {
        const available = context?.getRemainingTimeInMillis?.() ?? 200_000;
        await drain({ confirm: true, deadline: Date.now() + Math.min(180_000, available - 25_000) });
      }
      if (enabled && allowed(company)) {
        const ceo = await store.ensureCEO();
        if(adapters?.blobs && recordsFor) await createCompanyFiles({records:recordsFor(),blobs:adapters.blobs,employee:id=>store.employee(id)}).ensureSoul(ceo);
        if (event.RequestType === 'Create' && ceo.desiredState === 'active') {
          const status = await reconcile(ceo.id);
          if (!['starting', 'running'].includes(status)) throw new Error('CEO launch not accepted');
        } else await repair();
      }
      result.Status = 'SUCCESS';
    } catch {
      result.Status = 'FAILED';
      result.Reason = 'Factory could not apply the requested lifecycle change. Check the scoped deployment and durable employee state.';
    }
    await respond(event, result);
  }

  async function lifecycle(actor, op, input, common, company) {
    if (!requestFormat.test(input.requestId ?? '')) reject(400, 'INVALID_REQUEST');
    let employee;
    if (op === 'hire') {
      if (typeof input.role !== 'string' || !input.role.trim() || input.role.length > 120 ||
          (input.assignment !== undefined && (typeof input.assignment !== 'string' || input.assignment.length > 4000)))
        reject(400, 'INVALID_HIRE');
      for (let i = 0; i < 3; i++) {
        try {
          employee = await store.hireEmployee({ ...common, requestId: input.requestId, ...generatedIdentity(actor,input.requestId,i),
            generatedIdentity:true, role:input.role.trim(), ...(input.assignment && { assignment:input.assignment }), maxEmployees:company.employeeLimit });
          break;
        } catch (error) { if (error.code !== 'EMPLOYEE_IDENTITY_TAKEN' || i === 2) throw error; }
      }
    } else {
      const desiredState = { pause:'paused', resume:'active', fire:'fired' }[op];
      if (!desiredState || !idFormat.test(input.agentId ?? '')) reject(400,'INVALID_EMPLOYEE');
      employee = await store.setEmployeeState({ ...common, requestId:input.requestId, agentId:input.agentId, desiredState });
    }
    await reconcile(employee.id);
    return { employee: publicEmployee(employee) };
  }
  async function companyOperation(actor,event,common,company) {
    const { op, input = {} } = event.command ?? {};
    if (!recordsFor || typeof op !== 'string' || !/^[a-z][a-z.]{0,63}$/.test(op)) reject(400,'INVALID_REQUEST');
    const records = recordsFor(common.binding, company?.version);
    const service = createCompanyService({ records, store, adapters,
      heartbeat: data => store.recordPulse(common.binding,data,company.version),
      control: async (_actor, command, args, permit) => {
        if (!allowed(company) && command === 'employee.hire') reject(409,'COMPANY_SUSPENDED');
        // New assignments are explicit work records. Never pass through a legacy hire assignment.
        const {role,agentId,requestId} = args;
        return lifecycle(actor,command.slice(9),{role,agentId,requestId},{...common,governancePermit:permit},company);
      } });
    const run = () => service.execute(actor,op,input);
    const quiet = ['worker.poll','worker.heartbeat','directory','directory.self','company.overview','journal.get'].includes(op) ||
      (!op.startsWith('admin.') && /\.(?:list|get|status|history)$/.test(op));
    const result = quiet ? await run() : await withSpan(op.startsWith('admin.') ? 'company.admin_read' : 'company.command',
      {command:op,agentId:actor},run,{parent:event.trace});
    return {ok:true,result};
  }
  async function handleOwner(event) {
    if (!requestFormat.test(event?.requestId ?? '')) reject(400, 'INVALID_REQUEST');
    if (event.operation === 'company') return companyOperation('owner',event,{callerId:'owner'},await state.company());
    if (['pause-company', 'resume-company'].includes(event.operation)) {
      const company = await state.suspend(event.requestId, event.operation === 'pause-company');
      if (company.suspended) await drain(); else await repair();
      return { ok: true, suspended: company.suspended };
    }
    if (!['pause','resume','fire'].includes(event.operation)) reject(400,'INVALID_REQUEST');
    return {ok:true,...await lifecycle('owner',event.operation,event,{callerId:'owner'})};
  }
  async function handleManager(event) {
    if (!requestFormat.test(event?.requestId ?? '') || !idFormat.test(event.callerId ?? '') ||
        !['hire','fire','company'].includes(event.operation)) reject(400,'INVALID_REQUEST');
    const [company, caller, run] = await Promise.all([state.company(), store.employee(event.callerId), state.run(event.callerId)]);
    if (!allowed(company) || !run?.capability || run.epoch !== company.epoch ||
        run.revision !== company.deployment?.revision || !['launching','started'].includes(run.stage) ||
        caller?.desiredState !== 'active' || (event.operation !== 'company' && !caller.canHire) ||
        caller.generation !== event.generation || run.generation !== event.generation ||
        typeof event.taskArn !== 'string' || !event.taskArn || typeof event.capability !== 'string' ||
        event.capability.length !== run.capability.length || !timingSafeEqual(hash(event.capability),hash(run.capability)))
      reject(403,'MANAGER_DENIED');
    if (run.arn && run.arn !== event.taskArn || caller.taskArn && caller.taskArn !== event.taskArn) reject(403,'MANAGER_DENIED');
    if (!run.arn || !caller.taskArn) reject(503,'BINDING_PENDING');
    if (caller.taskGeneration !== event.generation) reject(403,'MANAGER_DENIED');
    const binding = {agentId:caller.id,generation:caller.generation,taskArn:caller.taskArn};
    const common = {callerId:caller.id,binding,companyGate:true,companyVersion:company.version};
    if (event.operation === 'company') return companyOperation(caller.id,event,common,company);
    if (recordsFor) reject(400,'USE_COMPANY_COMMAND');
    return {ok:true,...await lifecycle(caller.id,event.operation,event,common,company)};
  }
  async function safeAction(operation, event) {
    try { return await operation(event); }
    catch (error) {
      const status = [400, 403, 404, 409, 429].includes(error.status) ? error.status : 503;
      return { ok: false, status, ...(event?.operation === 'company' && status !== 503 && {message:error.message}), code: (status !== 503 || error.code === 'BINDING_PENDING') && /^[A-Z_]{2,60}$/.test(error.code ?? '') ? error.code : 'FACTORY_ACTION_FAILED' };
    }
  }
  return {
    owner: event => safeAction(handleOwner, event), manager: event => safeAction(handleManager, event), repair,
    async handler(event, context) {
      if (event?.RequestType && event.StackId && event.RequestId && event.LogicalResourceId) return custom(event, context);
      if (event?.source === 'aws.events' && event['detail-type'] === 'Scheduled Event') return repair();
      const d = event?.detail;
      if (event?.source === 'aws.ecs' && d?.lastStatus === 'STOPPED' && d.clusterArn === config.clusterArn
          && typeof d.taskArn === 'string' && d.group?.startsWith('employee-')) {
        const id = d.group.slice('employee-'.length);
        if (idFormat.test(id)) return reconcile(id, { stoppedArn: d.taskArn });
      }
      throw new Error('Unrecognized factory event');
    },
  };
}

let instance;
function factory() {
  if (!instance) {
    const { PEROTTINO_STATE_TABLE: tableName, PEROTTINO_CLUSTER_ARN: clusterArn, PEROTTINO_TASK_DEFINITION_ARN: taskDefinitionArn,
      PEROTTINO_PUBLIC_SUBNET_IDS, PEROTTINO_SECURITY_GROUP_ID: securityGroupId, PEROTTINO_EMPLOYEE_LIMIT } = process.env;
    const employeeLimit = Number(PEROTTINO_EMPLOYEE_LIMIT ?? maxCompanyEmployees);
    if (!isValidEmployeeLimit(employeeLimit)) throw new Error('Invalid employee limit');
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({maxAttempts:3}));
    const store = createCloudStore({tableName,client});
    instance = createEmployeeFactory({ store, adapters:hostedAdapters(), state:createFactoryState({tableName}),
      ...(process.env.PEROTTINO_FOUNDATIONS === '1' && {recordsFor:(binding,version) =>
        makeDynamoRecords({tableName,client,conditions:binding ? store.foundationGuards(binding,version) : []})}),
      ecs: new ECSClient({ maxAttempts: 2 }), config: { clusterArn, taskDefinitionArn, securityGroupId, employeeLimit,
        subnets: PEROTTINO_PUBLIC_SUBNET_IDS?.split(',') } });
  }
  return instance;
}
export async function handler(event, context) {
  try {
    if (event?.source === 'aws.events') {
      try { return await factory().handler(event,context); }
      catch (error) { operationFailure('work.failure',{reason:'store',outcome:'error'}); throw error; }
    }
    return await withSpan('factory.reconcile',{},() => factory().handler(event,context));
  }
  finally { await flushTelemetry(); }
}
async function command(handler,event) {
  try { return await factory()[handler](event); }
  finally { await flushTelemetry(); }
}
export const owner = event => command('owner',event);
export const manager = event => command('manager',event);
