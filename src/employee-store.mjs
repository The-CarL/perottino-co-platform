import { createHash, randomUUID } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

const digest = value => createHash('sha256').update(value).digest('hex');
const pkFor = id => 'AGENT#' + id;
const profile = id => ({ pk: 'DIRECTORY', sk: pkFor(id) });
const meta = id => ({ pk: pkFor(id), sk: 'META' });
const goalKey = (id, gid) => ({ pk: pkFor(id), sk: 'GOAL#' + gid });
const recentKey = (id, goal) => ({ pk: pkFor(id), sk: 'RECENT_GOAL#' + goal.updatedAt + '#' + goal.id });
const dueKey = (id, goal) => ({ pk: pkFor(id), sk: 'DUE#' + String(goal.nextRunAt).padStart(16, '0') + '#' + goal.id });
const roster = { pk: 'FACTORY#ROSTER', sk: 'COUNT' };
const alias = handle => ({ pk: roster.pk, sk: 'HANDLE#' + handle });
const givenName = name => ({ pk: roster.pk, sk: 'NAME#' + digest(name.normalize('NFKC').toLowerCase()) });
const iso = n => new Date(n).toISOString();
function problem(status, message, code) { return Object.assign(new Error(message), { status, code }); }
const forbidden = () => problem(403, 'Employee authority is unavailable.', 'EMPLOYEE_DENIED');
export const firedError = () => problem(409, 'This employee has been fired.', 'EMPLOYEE_FIRED');
function text(value, limit, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw problem(400, 'Invalid ' + name + '.');
  return value.trim();
}
function employeeView(row) {
  if (!row) return null;
  const { pk, sk, ...rest } = row;
  return { managerId: null, canHire: false, desiredState: 'active', generation: 1, taskArn: null, taskGeneration: null, ...rest };
}
function goalView(row) {
  if (!row) return null;
  const { pk, sk, token, leaseUntil, runArn, runGeneration, attempts, ...result } = row;
  return result;
}
function sameBinding(row, binding) {
  return row?.desiredState === 'active' && row.id === binding.agentId && row.generation === binding.generation
    && row.taskGeneration === binding.generation && row.taskArn === binding.taskArn && !!row.taskArn;
}
function validTime(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }

export function createEmployeeStore({ ddb, tableName, get, query, write, insert, put, remove, update, optimistic, now, getMemories, getHistory }) {
  const check = (Key, condition, values) => ({ ConditionCheck: { TableName: tableName, Key,
    ConditionExpression: condition, ExpressionAttributeValues: values } });
  function gateChecks(enabled = process.env.PEROTTINO_COMPANY_GATE === '1', companyVersion) {
    if (!enabled) return [];
    const field = companyVersion === undefined ? 'epoch' : 'version';
    const expected = companyVersion ?? Number(process.env.PEROTTINO_COMPANY_EPOCH);
    if (!Number.isSafeInteger(expected) || expected < 0) throw forbidden();
    return [{ ConditionCheck: { TableName: tableName, Key:{pk:'COMPANY#GATE',sk:'STATE'},
      ConditionExpression:'running=:yes AND #f=:v', ExpressionAttributeNames:{'#f':field},
      ExpressionAttributeValues:{':yes':true,':v':expected} } }];
  }
  function bindingCheck(b, extra = '') {
    if (!b || !b.agentId || !Number.isSafeInteger(b.generation) || !b.taskArn) throw forbidden();
    return check(profile(b.agentId), 'desiredState=:a AND generation=:g AND taskGeneration=:g AND taskArn=:t' + extra,
      { ':a': 'active', ':g': b.generation, ':t': b.taskArn, ...(extra && { ':yes': true }) });
  }
  const accepting = id => check(profile(id),
    'attribute_exists(pk) AND (attribute_not_exists(desiredState) OR desiredState<>:f)', { ':f': 'fired' });
  async function employee(id) { return employeeView(await get(profile(id))); }
  function receiptFor(op, caller, requestId) {
    text(requestId, 160, 'request id');
    return { pk: roster.pk, sk: 'ACTION#' + digest(JSON.stringify([op, caller, requestId])) };
  }
  async function replay(key, signature) {
    const receipt = await get(key);
    if (!receipt) return null;
    if (receipt.signature !== signature) throw problem(409, 'Request id belongs to a different operation.');
    return employee(receipt.employeeId);
  }
  function goalItems(agentId, requestId, content, checkpoint = '', nextRunAt = now(), source = 'owner') {
    const id = digest(JSON.stringify([agentId, source, requestId]));
    const at = iso(now());
    const goal = { id, text: text(content, 16000, 'goal'), checkpoint, status: 'ready', nextRunAt, stepCount: 0,
      revision: 0, createdAt: at, updatedAt: at, source };
    if (!validTime(nextRunAt) || typeof checkpoint !== 'string' || checkpoint.length > 16000) throw problem(400, 'Invalid goal checkpoint.');
    return { goal, actions: [insert({ ...goalKey(agentId, id), ...goal, attempts: 0 }), insert({ ...dueKey(agentId, goal), goalId: id }), insert({ ...recentKey(agentId, goal), goalId:id })] };
  }

  async function ensureCEO() {
    return optimistic(async () => {
      const e = await get(profile('ceo'));
      if (e?.desiredState && await get(roster)) return employeeView(e);
      const base = { id: 'ceo', name: 'Mara', handle: 'mara', role: 'CEO', managerId: null, canHire: true,
        desiredState: 'active', generation: 1, ...(e ?? {}) };
      const saved = await write([e?.desiredState ? check(profile('ceo'), 'desiredState=:s', { ':s':e.desiredState }) : e ? put(base, { ConditionExpression: 'attribute_not_exists(desiredState)' }) : insert({ ...profile('ceo'), ...base }),
        update(meta('ceo'), { UpdateExpression: 'SET lastSequence=if_not_exists(lastSequence,:z), memoryRevision=if_not_exists(memoryRevision,:z)', ExpressionAttributeValues: { ':z': 0 } }),
        update(roster, { UpdateExpression: 'SET headcount=if_not_exists(headcount,:n)', ExpressionAttributeValues: { ':n': base.desiredState === 'fired' ? 0 : 1 } }),
        update(givenName('Mara'), { UpdateExpression: 'SET employeeId=:id', ConditionExpression: 'attribute_not_exists(employeeId) OR employeeId=:id', ExpressionAttributeValues: { ':id': 'ceo' } }),
        update(alias('mara'), { UpdateExpression: 'SET employeeId=:id', ConditionExpression: 'attribute_not_exists(employeeId) OR employeeId=:id', ExpressionAttributeValues: { ':id': 'ceo' } })]);
      if (saved) return employee('ceo');
    });
  }

  async function hireEmployee({ callerId, name, handle, role, requestId, assignment, binding, companyGate, companyVersion, generatedIdentity = false, maxEmployees = Number(process.env.PEROTTINO_EMPLOYEE_LIMIT ?? 2) }) {
    name = text(name, 100, 'name'); role = text(role, 160, 'role'); handle = text(handle, 48, 'handle').toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(handle) || ['owner','ceo','mara'].includes(handle)) throw problem(409, 'Handle is reserved or invalid.');
    if (!Number.isSafeInteger(maxEmployees) || maxEmployees < 1 || maxEmployees > 30) throw problem(400, 'Invalid employee limit.');
    const managerId = callerId === 'owner' ? 'ceo' : callerId;
    const receipt = receiptFor('hire', callerId, requestId);
    const signature = digest(JSON.stringify([generatedIdentity ? null : name, generatedIdentity ? null : handle, role, assignment ?? '']));
    const id = 'e-' + digest(receipt.sk).slice(0, 24);
    if (callerId !== 'owner' && binding?.agentId !== callerId) throw forbidden();
    return optimistic(async () => {
      const existing = await replay(receipt, signature);
      if (existing) return existing;
      const manager = await employee(managerId);
      if (manager?.desiredState !== 'active' || (callerId !== 'owner' && (!manager.canHire || !sameBinding(manager, binding)))) throw forbidden();
      const [byHandle, byName, count] = await Promise.all([get(alias(handle)), get(givenName(name)), get(roster)]);
      const reserved = byHandle || byName;
      if (!count) throw problem(409, 'The company must be bootstrapped first.');
      if (reserved || count.headcount >= maxEmployees) {
        const raced = await replay(receipt, signature);
        if (raced) return raced;
        throw problem(409, reserved ? 'This name or handle is already reserved.' : 'Employee limit reached.', reserved ? 'EMPLOYEE_IDENTITY_TAKEN' : 'EMPLOYEE_LIMIT');
      }
      const row = { ...profile(id), id, name, handle, role, managerId, canHire: false, desiredState: 'active', generation: 1, createdAt: iso(now()) };
      const actions = [insert(row), insert({ ...meta(id), lastSequence: 0, memoryRevision: 0 }),
        insert({ ...alias(handle), employeeId: id }), insert({ ...givenName(name), employeeId: id }), insert({ ...receipt, signature, employeeId: id }),
        update(roster, { UpdateExpression: 'ADD headcount :one', ConditionExpression: 'headcount < :cap', ExpressionAttributeValues: { ':cap': maxEmployees, ':one': 1 } }),
        ...(callerId === 'owner' ? [] : gateChecks(companyGate,companyVersion)),
        callerId === 'owner' ? check(profile(managerId), 'desiredState=:active', { ':active': 'active' }) : bindingCheck(binding, ' AND canHire=:yes')];
      if (assignment) actions.push(...goalItems(id, requestId, assignment, '', now(), 'manager').actions);
      if (await write(actions)) return employeeView(row);
    });
  }

  async function setEmployeeState({ callerId, agentId, desiredState, requestId, binding, companyGate, companyVersion }) {
    if (!['active','paused','fired'].includes(desiredState)) throw problem(400, 'Invalid desired employee state.');
    if (callerId !== 'owner' && binding?.agentId !== callerId) throw forbidden();
    const receipt = receiptFor('state', callerId, requestId);
    const signature = digest(JSON.stringify([agentId, desiredState]));
    return optimistic(async () => {
      const existing = await replay(receipt, signature);
      if (existing) return existing;
      const target = await employee(agentId);
      if (!target) throw problem(404, 'Employee not found.');
      if (callerId !== 'owner') {
        const manager = await employee(callerId);
        if (target.managerId !== callerId || !manager?.canHire || !sameBinding(manager, binding)) throw forbidden();
      }
      if (target.desiredState === 'fired' && desiredState !== 'fired') throw firedError();
      const changed = target.desiredState !== desiredState;
      const next = target.generation + Number(changed);
      const actions = [insert({ ...receipt, signature, employeeId: agentId }),
        update(profile(agentId), { UpdateExpression: 'SET desiredState=:d, generation=:n, updatedAt=:at',
          ConditionExpression: 'generation=:g AND desiredState=:s', ExpressionAttributeValues: { ':d': desiredState, ':n': next,
            ':g': target.generation, ':s': target.desiredState, ':at': iso(now()) } })];
      if (callerId !== 'owner') actions.push(...gateChecks(companyGate,companyVersion),bindingCheck(binding, ' AND canHire=:yes'));
      if (changed && desiredState === 'fired') actions.push(update(roster, { UpdateExpression: 'ADD headcount :minus',
        ConditionExpression: 'headcount > :zero', ExpressionAttributeValues: { ':minus': -1, ':zero': 0 } }));
      if (await write(actions)) return employee(agentId);
    });
  }

  async function bindEmployeeTask({ agentId, generation, taskArn }) {
    if (!Number.isSafeInteger(generation) || generation < 1 || !taskArn) throw problem(400, 'Invalid task binding.');
    return write([update(profile(agentId), { UpdateExpression: 'SET taskArn=:t, taskGeneration=:g',
      ConditionExpression: 'desiredState=:a AND generation=:g AND (attribute_not_exists(taskArn) OR (taskArn=:t AND taskGeneration=:g))',
      ExpressionAttributeValues: { ':t': taskArn, ':g': generation, ':a': 'active' } })]);
  }
  async function clearEmployeeTask({ agentId, generation, taskArn }) {
    return write([update(profile(agentId), { UpdateExpression: 'REMOVE taskArn, taskGeneration',
      ConditionExpression: 'taskGeneration=:g AND taskArn=:t', ExpressionAttributeValues: { ':g': generation, ':t': taskArn } })]);
  }

  async function assignGoal(agentId, content, requestId) {
    text(requestId, 160, 'request id');
    const { goal, actions } = goalItems(agentId, requestId, content);
    return optimistic(async () => {
      const existing = await get(goalKey(agentId, goal.id));
      if (existing) return { goal: goalView(existing), conflict: existing.text !== goal.text };
      const person = await employee(agentId);
      if (!person) throw problem(404, 'Employee not found.');
      if (person.desiredState === 'fired') throw firedError();
      if (await write([...actions, accepting(agentId)])) return { goal, conflict: false };
    });
  }
  function lockWork(binding, token, leaseMs, lastSequence) {
    return [...gateChecks(), bindingCheck(binding), update(meta(binding.agentId), {
      UpdateExpression: 'SET activeToken=:t, activeUntil=:until, activeArn=:arn, activeGeneration=:g',
      ConditionExpression: '(attribute_not_exists(activeToken) OR activeUntil<=:now OR activeArn<>:arn OR activeGeneration<>:g)' +
        (lastSequence === undefined ? '' : ' AND lastSequence=:seq'),
      ExpressionAttributeValues: { ':t': token, ':until': now() + leaseMs, ':now': now(), ':arn': binding.taskArn, ':g': binding.generation,
        ...(lastSequence === undefined ? {} : { ':seq': lastSequence }) }
    })];
  }
  function unlockWork(job, revision, bump = false) {
    const values = { ':t': job.token };
    if (revision !== undefined) values[':r'] = revision;
    if (bump) values[':one'] = 1;
    return update(meta(job.agent.id), { UpdateExpression: 'REMOVE activeToken, activeUntil, activeArn, activeGeneration' + (bump ? ' ADD memoryRevision :one' : ''),
      ConditionExpression: 'activeToken=:t' + (revision === undefined ? '' : ' AND memoryRevision=:r'), ExpressionAttributeValues: values });
  }

  async function checkpointGoal(job, { checkpoint, status, nextRunAt = now() }, consume = true) {
    if (!['ready','waiting','done','blocked'].includes(status) || !validTime(nextRunAt) || typeof checkpoint !== 'string' || checkpoint.length > 16000) throw problem(400,'Invalid goal checkpoint.');
    const id = job.agent.id;
    const steps = job.goal.stepCount + Number(consume);
    if (steps >= 12 && !['done','blocked'].includes(status)) status = 'blocked';
    const next = { ...job.goal, checkpoint, status, nextRunAt, stepCount: steps, updatedAt: iso(now()), revision: job.goal.revision + 1 };
    const actions = [...gateChecks(), bindingCheck(job.binding), unlockWork(job, consume ? job.memoryRevision : undefined),
      put({ ...goalKey(id, next.id), ...next, attempts: consume ? 0 : job.attempts }, {
        ConditionExpression: '#t=:t AND leaseUntil>:now', ExpressionAttributeNames: { '#t': 'token' }, ExpressionAttributeValues: { ':t': job.token, ':now': now() } })];
    const oldRecent = recentKey(id, job.goal);
    if (oldRecent.sk !== recentKey(id, next).sk) actions.push(remove(oldRecent), insert({ ...recentKey(id, next), goalId:next.id }));
    const oldDue = dueKey(id, job.goal);
    if (status === 'done' || status === 'blocked') actions.push(remove(oldDue));
    else if (oldDue.sk !== dueKey(id, next).sk) actions.push(remove(oldDue), insert({ ...dueKey(id, next), goalId: next.id }));
    return write(actions);
  }
  async function claimGoal(binding, leaseMs, lastSequence) {
    const id = binding.agentId;
    const [due] = await query(pkFor(id), 'DUE#', { first: true });
    if (!due || due.sk > 'DUE#' + String(now()).padStart(16,'0') + '#\uffff') return { state: 'idle' };
    const key = goalKey(id, due.goalId);
    const row = await get(key);
    if (!row || !['ready','working','waiting'].includes(row.status)) return { state: 'busy' };
    const token = randomUUID();
    const time = now();
    const winner = await write([...lockWork(binding, token, leaseMs, lastSequence),
      update(key, { UpdateExpression: 'SET #s=:w,#t=:t,leaseUntil=:until,runGeneration=:g,runArn=:arn ADD attempts :one',
        ConditionExpression: 'revision=:r AND nextRunAt<=:now AND (#s=:ready OR #s=:waiting OR (#s=:w AND (leaseUntil<=:now OR runGeneration<>:g OR runArn<>:arn)))',
        ExpressionAttributeNames: { '#s':'status','#t':'token' }, ExpressionAttributeValues: { ':w':'working', ':ready':'ready', ':waiting':'waiting',
          ':t':token, ':until':time+leaseMs, ':g':binding.generation, ':arn':binding.taskArn, ':one':1, ':r':row.revision, ':now':time } })]);
    if (!winner) return { state: 'busy' };
    const control = await get(meta(id));
    const [agent, memories, history] = await Promise.all([employee(id), getMemories(id), getHistory(id)]);
    const goal = goalView(row);
    const job = { binding, agent, token, goal, attempts: row.attempts + 1, memoryRevision:control.memoryRevision, memories, history, message: { id:goal.id, author:'owner', text:goal.text } };
    if (job.attempts > 3) {
      await checkpointGoal(job, { checkpoint:goal.checkpoint, status:'blocked' }, false);
      return { state:'busy' };
    }
    return { state:'claimed', kind:'goal', job };
  }

  return { accepting, bindingCheck, gateChecks, lockWork, unlockWork, goalItems, claimGoal, checkpointGoal,
    employee, ensureCEO, hireEmployee, setEmployeeState, bindEmployeeTask, clearEmployeeTask, assignGoal,
    async getGoal(id,gid) { return goalView(await get(goalKey(id,gid))); },
    async listGoals(id) {
      const markers = (await query(pkFor(id), 'RECENT_GOAL#', { recent:20 })).reverse();
      const goals = await Promise.all(markers.map(m => get(goalKey(id,m.goalId))));
      return goals.filter(Boolean).map(goalView);
    },
    async listEmployees() { return (await query('DIRECTORY','AGENT#')).map(employeeView); },
    async employeePage({ cursor, limit=20 }={}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 30 || (cursor && !/^AGENT#[a-z0-9_-]+$/.test(cursor))) throw problem(400, 'Invalid directory page.');
      const p = await ddb.send(new QueryCommand({ TableName:tableName, ConsistentRead:true, KeyConditionExpression:'pk=:pk AND begins_with(sk,:pre)',
        ExpressionAttributeValues:{':pk':'DIRECTORY',':pre':'AGENT#'}, Limit:limit, ...(cursor && {ExclusiveStartKey:{pk:'DIRECTORY',sk:cursor}}) }));
      return { employees:(p.Items ?? []).map(employeeView), ...(p.LastEvaluatedKey && {cursor:p.LastEvaluatedKey.sk}) };
    },
    async recordPulse(binding, { nextPulseAt, summary='' }) {
      if (!validTime(nextPulseAt) || typeof summary !== 'string' || summary.length > 2000) throw problem(400, 'Invalid pulse.');
      return write([...gateChecks(), bindingCheck(binding), put({ pk:pkFor(binding.agentId), sk:'PULSE', generation:binding.generation, at:now(), nextPulseAt, summary })]);
    },
    async getPulse(id) { const row = await get({ pk:pkFor(id), sk:'PULSE' }); if (!row) return null; const {pk,sk,...pulse}=row; return pulse; }
  };
}
