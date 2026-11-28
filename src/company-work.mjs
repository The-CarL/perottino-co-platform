import { createHash, randomBytes } from 'node:crypto';
import { eventRows } from './company-events.mjs';
import { traceCarrier } from './telemetry.mjs';
import { notificationRow } from './company-notifications.mjs';

const goals = 'work:goals';
const tasks = 'work:tasks';
const taskStates = ['ready', 'running', 'waiting', 'blocked', 'submitted', 'done'];
const mutations = new Set(['goal.create','goal.close','task.create','task.claim','task.progress','task.wait','task.block',
  'task.resume','task.submit','task.review']);
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = time => new Date(time).toISOString();
const assignedGoals = id => 'work:goals:assigned:' + id;
const unplanned = id => 'work:goals:unplanned:' + id;
const closable = id => 'work:goals:closable:' + id;
const assignedTasks = id => 'work:tasks:assigned:' + id;
const goalTasks = id => 'work:tasks:goal:' + id;
const available = id => 'work:tasks:available:' + id;
const reviews = id => 'work:tasks:review:' + id;
const history = id => 'work:tasks:history:' + id;
const participants = id => 'work:participation:' + id;
const index = (pk, sk) => ({pk,sk});
const due = (time,id) => String(time).padStart(16,'0') + '#' + id;
const problem = (status,message) => Object.assign(new Error(message),{status});
function requireThat(condition,status,message) { if (!condition) throw problem(status,message); }
function string(value,name,limit = 4000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= limit,400,'Invalid ' + name + '.');
  return value.trim();
}
function identifier(value) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value),400,'Invalid identifier.');
  return value;
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]));
  return value;
}
function fields(row) {
  const {pk,sk,version,...rest} = row;
  return rest;
}
function publicWork(resource, handoff = false) {
  const {claimDigest,availableAt,traceContext,source,sourceMail,...rest} = resource;
  return handoff && traceContext ? {...rest,traceContext} : rest;
}
function listOf(value,check,max) {
  requireThat(Array.isArray(value) && value.length<=max,400,'Invalid list.');
  return [...new Set(value.map(check))];
}

function claimable(task,time) {
  return task.status === 'ready' || (task.status === 'waiting' && task.wakeAt != null && task.wakeAt <= time)
    || (task.status === 'running' && task.leaseUntil <= time);
}

function goalIndexes(g) {
  const result = [index(assignedGoals(g.accountableId),g.id)];
  if (g.status === 'active' && g.taskCount === 0) result.push(index(unplanned(g.accountableId),g.id));
  if (g.status === 'active' && g.taskCount > 0 && g.openTaskCount === 0) result.push(index(closable(g.accountableId),g.id));
  return result;
}
function taskIndexes(t) {
  const result = [index(assignedTasks(t.assigneeId),t.id),index(goalTasks(t.goalId),t.id)];
  if (t.status === 'submitted') result.push(index(reviews(t.reviewerId),t.id));
  const time = t.status === 'ready' ? (t.availableAt ?? 0) : t.status === 'running' ? t.leaseUntil : t.status === 'waiting' ? t.wakeAt : null;
  if (time != null) result.push(index(available(t.assigneeId),due(time,t.id)));
  return result;
}

export function createWork({records,employee,event = eventRows,currentTrace = traceCarrier,canReadSource,canUseMailSource,now = Date.now,leaseMs = 150000}) {
  requireThat(Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 900000,500,'Invalid task lease.');
  function handoff(prior) {
    const traceparent = currentTrace()?.traceparent ?? prior?.traceparent;
    return traceparent ? {traceContext:{traceparent}} : {};
  }
  async function sourceForCreation(actor,accountableId,input) {
    if (input == null) return {};
    requireThat(typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 2,
      400,'Invalid source message.');
    const source = {conversationId:identifier(input.conversationId), messageId:identifier(input.messageId)};
    requireThat(canReadSource && await canReadSource(actor,source) &&
      (actor === accountableId || await canReadSource(accountableId,source)),404,'Source message not found.');
    return {source};
  }
  async function mailSource(actor,accountable,input) {
    if(input.sourceMail==null) return {};
    const v=input.sourceMail;
    requireThat(!input.source && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===2,400,'Invalid source email.');
    const sourceMail={threadId:identifier(v.threadId),messageId:identifier(v.messageId)};
    requireThat(canUseMailSource && await canUseMailSource(actor,sourceMail) &&
      (actor===accountable || await canUseMailSource(accountable,sourceMail)),404,'Authorized source email not found.');
    return {sourceMail};
  }
  async function person(id) {
    const row = await employee(identifier(id));
    requireThat(row && row.desiredState !== 'fired',404,'Employee not found.');
    return row;
  }
  async function manages(actor,id) {
    if (actor === 'owner') return true;
    const visited = new Set([id]);
    let current = await employee(id);
    while (current?.managerId && !visited.has(current.managerId)) {
      if (current.managerId === actor) return true;
      visited.add(current.managerId);
      current = await employee(current.managerId);
    }
    return false;
  }
  async function fetch(pk,id) {
    const row = await records.get(pk,identifier(id));
    requireThat(row,404,pk === tasks ? 'Task not found.' : 'Goal not found.');
    return row;
  }
  async function canReadGoal(actor,g) {
    return actor === g.accountableId || await manages(actor,g.accountableId)
      || Boolean(await records.get(participants(actor),g.id));
  }
  async function canReadTask(actor,t) {
    if (actor === t.assigneeId || await manages(actor,t.assigneeId)) return true;
    const g = await fetch(goals,t.goalId);
    return actor === g.accountableId || await manages(actor,g.accountableId);
  }
  async function dependenciesDone(t) {
    const rows = await Promise.all(t.dependencies.map(id=>records.get(tasks,id)));
    return rows.every(row=>row?.status === 'done');
  }

  async function save(changes,pk,old,updated,indexes) {
    changes.push({pk,sk:updated.id,expect:old?.version ?? null,value:updated});
    const previous = old ? indexes(old) : [];
    const next = indexes(updated);
    const has = (entries,key) => entries.some(item=>item.pk === key.pk && item.sk === key.sk);
    // Deletion and recreation retain a monotonically increasing version in both adapters.
    for (const key of previous) if (!has(next,key)) {
      const row = await records.get(key.pk,key.sk);
      if (row) changes.push({...key,expect:row.version,value:null});
    }
    for (const key of next) if (!has(previous,key)) changes.push({...key,expect:null,value:{id:updated.id}});
  }

  async function list(actor,op,input) {
    const isGoal = op === 'goal.list';
    const primary = isGoal ? goals : tasks;
    const limit = input.limit ?? 40;
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 100,400,'Invalid page size.');
    if (input.after != null) string(input.after,'cursor',256);
    const status = input.status;
    if (status) requireThat((isGoal ? ['active','done'] : taskStates).includes(status),400,'Invalid status.');
    if (isGoal) requireThat(!(input.unplanned && input.closable),400,'Select one goal filter.');
    else {
      requireThat([input.goalId,input.assigneeId,input.reviewerId].filter(Boolean).length <= 1,400,'Select one task scope.');
      if (input.available) requireThat(!input.goalId && !input.reviewerId && !status,400,'Availability uses the assignee scope.');
    }
    let pk = primary;
    if (isGoal) {
      const accountable = input.accountableId ?? (actor === 'owner' ? null : actor);
      if (accountable) {
        identifier(accountable);
        requireThat(accountable === actor || await manages(actor,accountable),403,'Goal list is outside your scope.');
        pk = input.unplanned ? unplanned(accountable) : input.closable ? closable(accountable) : assignedGoals(accountable);
      } else requireThat(!input.unplanned && !input.closable,400,'Select an accountable employee.');
    } else if (input.goalId) {
      const g = await fetch(goals,input.goalId);
      requireThat(await canReadGoal(actor,g),403,'Goal is outside your scope.');
      pk = goalTasks(g.id);
    } else if (input.reviewerId) {
      const reviewer = identifier(input.reviewerId);
      requireThat(actor === reviewer || actor === 'owner',403,'Review list is outside your scope.');
      pk = reviews(reviewer);
    } else {
      const assignee = input.assigneeId ?? (actor === 'owner' ? null : actor);
      if (assignee) {
        identifier(assignee);
        requireThat(assignee === actor || await manages(actor,assignee),403,'Task list is outside your scope.');
        pk = input.available ? available(assignee) : assignedTasks(assignee);
      } else requireThat(!input.available,400,'Select an assignee.');
    }
    const result = [];
    let after = input.after;
    let scanned = 0;
    const response = next => ({[isGoal ? 'goals' : 'tasks']:result,...(next ? {next} : {})});
    do {
      const page = await records.list(pk,{limit:Math.min(100,Math.max(8,limit)),...(after ? {after} : {})});
      for (const [i,item] of page.items.entries()) {
        if (input.available && pk.startsWith('work:tasks:available:') && Number(item.sk.split('#')[0]) > now()) return response();
        const row = pk === primary ? item : await records.get(primary,item.id);
        scanned++;
        if (!row || (status && row.status !== status)) continue;
        if (input.unplanned && (row.status !== 'active' || row.taskCount !== 0)) continue;
        if (input.closable && (row.status !== 'active' || !row.taskCount || row.openTaskCount !== 0)) continue;
        if (input.reviewerId && row.status !== 'submitted') continue;
        if (!isGoal && input.goalId && !await canReadTask(actor,row)) continue;
        if (input.reviewerId && actor !== 'owner' && !await manages(actor,row.assigneeId)) continue;
        if (input.available && (!claimable(row,now()) || !await dependenciesDone(row))) continue;
        result.push(publicWork(fields(row), input.available || input.reviewerId || input.unplanned || input.closable));
        if (result.length === limit) return response(i+1 < page.items.length || page.next ? item.sk : undefined);
      }
      after = page.next;
    } while (after && scanned < 512);
    return response(after);
  }

  async function change(actor,op,input,requestKey,changes) {
    const time = now(), at = iso(time);
    if (op === 'goal.create') {
      const accountable = await person(input.accountableId);
      requireThat(await manages(actor,accountable.id) || (actor === 'ceo' && accountable.id === actor),403,'Only a leader can assign this goal.');
      const goal = {id:requestKey,...handoff(),...await sourceForCreation(actor,accountable.id,input.source),...await mailSource(actor,accountable.id,input),accountableId:accountable.id,outcome:string(input.outcome,'outcome'),
        successCriteria:string(input.successCriteria,'success criteria'),createdBy:actor,createdAt:at,updatedAt:at,
        status:'active',taskCount:0,openTaskCount:0};
      await save(changes,goals,null,goal,goalIndexes);
      return {kind:'goal.created',result:{goal:publicWork(goal)}};
    }
    if (op === 'goal.close') {
      const old = await fetch(goals,input.goalId);
      requireThat(actor === old.accountableId || await manages(actor,old.accountableId),403,'You cannot close this goal.');
      requireThat(old.status === 'active' && old.taskCount > 0 && old.openTaskCount === 0,409,'All tasks must pass review before closing the goal.');
      const goal = {...fields(old),status:'done',updatedAt:at,closedBy:actor};
      await save(changes,goals,old,goal,goalIndexes);
      const notification = notificationRow(goal,(goal.sourceMail || goal.source) && input.requesterReply ? string(input.requesterReply,'requester reply',8000) : undefined);
      if (notification) changes.push(notification);
      return {kind:'goal.closed',result:{goal:publicWork(goal)}};
    }
    if (op === 'task.create') {
      const g = await fetch(goals,input.goalId), assignee = await person(input.assigneeId);
      const selfPlan = actor === assignee.id && await canReadGoal(actor,g);
      const directed = await manages(actor,assignee.id) && await canReadGoal(actor,g);
      requireThat(selfPlan || directed,403,'You cannot assign this task.');
      requireThat(assignee.id === g.accountableId || await manages(g.accountableId,assignee.id),403,'Assignee is outside this goal.');
      requireThat(g.status === 'active' && (!input.ifUnplanned || g.taskCount === 0),409,'The goal is closed or has already been planned.');
      const dependencies = listOf(input.dependencies ?? [],identifier,24);
      for (const id of dependencies) requireThat((await fetch(tasks,id)).goalId === g.id,400,'Dependency belongs to another goal.');
      // Immutable links to previously created tasks cannot introduce a dependency cycle.
      const task = {id:requestKey,...handoff(g.traceContext),availableAt:time,revision:1,goalId:g.id,assigneeId:assignee.id,reviewerId:assignee.id === g.accountableId
        ? (assignee.managerId ?? 'owner') : g.accountableId,title:string(input.title,'title',320),
        acceptance:string(input.acceptance,'acceptance'),dependencies,status:'ready',attempt:0,workStep:0,
        createdBy:actor,createdAt:at,updatedAt:at};
      await save(changes,tasks,null,task,taskIndexes);
      await save(changes,goals,g,{...fields(g),taskCount:g.taskCount+1,openTaskCount:g.openTaskCount+1,updatedAt:at},goalIndexes);
      const key = index(participants(assignee.id),g.id);
      if (!await records.get(key.pk,key.sk)) changes.push({...key,expect:null,value:{id:g.id}});
      return {kind:'task.created',result:{task:publicWork(task)}};
    }

    const old = await fetch(tasks,input.taskId);
    const task = {...fields(old),revision:(old.revision ?? old.version)+1,updatedAt:at};
    let kind, claimToken;
    if (op === 'task.claim') {
      requireThat(actor === task.assigneeId,403,'Only the assignee can claim this task.');
      requireThat(claimable(task,time) && await dependenciesDone(task),409,'Task is unavailable or has pending dependencies.');
      claimToken = randomBytes(32).toString('hex');
      task.claimDigest = digest(claimToken);
      task.status = 'running'; task.leaseUntil = time+leaseMs; task.attempt++;
      delete task.wakeAt;
      kind = 'task.claimed';
    } else if (op === 'task.review') {
      requireThat(actor !== task.assigneeId && (actor === 'owner' || await manages(actor,task.assigneeId)),403,'An independent leader must review this task.');
      requireThat(task.status === 'submitted',409,'Task needs a submission before review.');
      requireThat(['accept','changes'].includes(input.decision),400,'Invalid review decision.');
      task.review = {decision:input.decision,note:string(input.note,'review'),by:actor,at};
      if (input.decision === 'accept') {
        const g = await fetch(goals,task.goalId);
        requireThat(g.status === 'active' && g.openTaskCount > 0,409,'Goal is unavailable.');
        await save(changes,goals,g,{...fields(g),openTaskCount:g.openTaskCount-1,updatedAt:at,
          ...(g.openTaskCount === 1 && handoff(task.traceContext))},goalIndexes);
      }
      task.status = input.decision === 'accept' ? 'done' : 'ready';
      task.workStep++; kind = 'task.reviewed';
    } else if (op === 'task.resume') {
      requireThat(actor === task.assigneeId || await manages(actor,task.assigneeId),403,'Task is outside your scope.');
      requireThat(['waiting','blocked'].includes(task.status),409,'Task is not waiting or blocked.');
      if (input.clarification != null) {
        requireThat(actor !== task.assigneeId,403,'Only an owner or manager can clarify the assignment.');
        task.clarification = {text:string(input.clarification,'clarification'),by:actor,at};
      }
      delete task.wakeAt; task.status = 'ready'; task.workStep++; kind = 'task.resumed';
    } else {
      requireThat(actor === task.assigneeId,403,'Only the assignee can update its claimed work.');
      requireThat(task.status === 'running' && task.leaseUntil > time && typeof input.claimToken === 'string'
        && input.claimToken.length === 64 && digest(input.claimToken) === task.claimDigest,409,'Task claim expired or was replaced.');
      if (op === 'task.submit') {
        task.evidence = listOf(input.evidence,v=>string(v,'evidence',2000),12);
        requireThat(task.evidence.length,400,'Submission requires evidence.');
        if (input.note !== undefined) task.progress = string(input.note,'note');
        task.submittedAt = at; task.status = 'submitted'; kind = 'task.submitted';
      } else {
        task.progress = string(input.note,'progress');
        if (op === 'task.wait') {
          if (input.wakeAt != null) {
            requireThat(Number.isSafeInteger(input.wakeAt) && input.wakeAt > time && input.wakeAt <= 8640000000000000,400,'Invalid wake time.');
            task.wakeAt = input.wakeAt;
          }
          task.status = 'waiting'; kind = 'task.waiting';
        } else if (op === 'task.block') { task.status = 'blocked'; kind = 'task.blocked'; }
        else { task.status = input.release === true ? 'ready' : 'running'; kind = 'task.progress'; }
      }
      if (task.status !== 'running') { delete task.claimDigest; delete task.leaseUntil; }
      task.workStep++;
    }
    if (op !== 'task.claim') Object.assign(task,handoff(task.traceContext));
    if (task.status === 'ready') task.availableAt = time;
    else delete task.availableAt;
    await save(changes,tasks,old,task,taskIndexes);
    return {kind,result:{task:publicWork(task,op === 'task.claim'),...(claimToken ? {claimToken} : {})}};
  }

  async function execute(actor,op,input={}) {
    identifier(actor);
    requireThat(input && typeof input === 'object' && !Array.isArray(input),400,'Invalid work input.');
    if (actor !== 'owner') requireThat((await person(actor)).desiredState !== 'paused',403,'Employee is paused.');
    if (op === 'goal.list' || op === 'task.list') return list(actor,op,input);
    if (op === 'goal.get') {
      const g = await fetch(goals,input.goalId);
      requireThat(await canReadGoal(actor,g),403,'Goal is outside your scope.');
      return {goal:publicWork(fields(g))};
    }
    if (op === 'task.history') {
      const t = await fetch(tasks,input.taskId);
      requireThat(await canReadTask(actor,t),403,'Task is outside your scope.');
      const limit = input.limit ?? 40;
      requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 100,400,'Invalid page size.');
      const page = await records.list(history(t.id),{limit,...(input.after ? {after:string(input.after,'cursor',256)} : {})});
      return {entries:page.items.map(fields),...(page.next ? {next:page.next} : {})};
    }
    if (op === 'task.get') {
      const t = await fetch(tasks,input.taskId);
      requireThat(await canReadTask(actor,t),403,'Task is outside your scope.');
      return {task:publicWork(fields(t))};
    }
    requireThat(mutations.has(op),400,'Unknown work operation.');
    const requestId = string(input.requestId,'request ID',160);
    const serialized = JSON.stringify(input);
    requireThat(Buffer.byteLength(serialized) <= 48000,400,'Work input is too large.');
    const signature = digest(JSON.stringify(sorted(input)));
    const id = digest(JSON.stringify([actor,op,requestId]));
    const key = index('work:requests:'+actor,id);
    const replay = row => {
      requireThat(row.signature === signature,409,'Request ID already belongs to different input.');
      return row.result;
    };
    for (let n=0; n<16; n++) {
      const stored = await records.get(key.pk,key.sk);
      if (stored) return replay(stored);
      const changes = [];
      let completed;
      try { completed = await change(actor,op,input,id,changes); }
      catch (error) {
        // A concurrent retry may have committed between the receipt and business reads.
        const winner = await records.get(key.pk,key.sk);
        if (winner) return replay(winner);
        throw error;
      }
      const {kind,result} = completed;
      const resource = result.task ?? result.goal;
      const metadata = {actor,goalId:result.goal?.id ?? resource.goalId,status:resource.status,
        ...(result.task ? {taskId:resource.id,assigneeId:resource.assigneeId} : {assigneeId:resource.accountableId})};
      if (result.task) {
        const entry = {revision:resource.revision,kind,actor,at:resource.updatedAt,status:resource.status,attempt:resource.attempt};
        if (['task.progress','task.block','task.wait','task.submit','task.review'].includes(op) && input.note) entry.note = input.note.trim();
        if (op === 'task.resume' && input.clarification != null) entry.note = resource.clarification.text;
        if (op === 'task.submit') entry.evidence = resource.evidence;
        if (op === 'task.review') entry.decision = resource.review.decision;
        changes.push({pk:history(resource.id),sk:String(resource.revision).padStart(16,'0'),expect:null,value:entry});
      }
      changes.push(...event(kind,metadata,id),{...key,expect:null,value:{signature,result}});
      if (await records.transact(changes)) return result;
    }
    throw problem(409,'Work changed concurrently. Retry the same request.');
  }
  return {execute};
}
