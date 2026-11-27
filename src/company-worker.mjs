import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkCompanyDecision, companySdkDecision, localCompanyDecision } from './company-decisions.mjs';
import { withSpan } from './telemetry.mjs';

const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const leaseMs = 150_000;
const maxSteps = 6;
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] != null).map(key => [key, row[key]]));
const employee = row => pick(row, ['id','handle','name','role','managerId','canHire']);
const goal = row => pick(row, ['id','outcome','successCriteria','accountableId','taskCount','openTaskCount','status']);
const task = row => pick(row, ['id','goalId','assigneeId','reviewerId','title','acceptance','dependencies','status','progress','evidence','review','workStep']);
const message = row => pick(row, ['id','senderId','text','seq','replyTo']);
const shared = ['dm.send','group.create','group.send','conversations.list','browse'];
const workActions = {
  plan: ['task.create','employee.hire','pass', ...shared],
  task: ['task.progress','task.wait','task.block','task.submit','task.create','employee.hire', ...shared],
  review: ['task.review','pass','browse'],
  close: ['goal.close','task.create','pass','browse'],
};

function permitted(ctx) {
  let ops;
  if (ctx.kind === 'message') {
    const trusted = ctx.message.senderId === 'owner' ||
      (Boolean(ctx.agent.managerId) && ctx.message.senderId === ctx.agent.managerId);
    ops = trusted ? ['reply','pass','goal.create','task.create','employee.hire','employee.fire','memory.list','memory.save', ...shared]
      : ['reply','pass'];
  } else ops = workActions[ctx.kind];
  if (!ctx.agent.canHire) ops = ops.filter(op => !['employee.hire','employee.fire'].includes(op));
  if (ctx.kind === 'task' && ctx.task.workStep >= 12) ops = ['task.block','task.submit'];
  return ops;
}

// A journal key describes an input or a logical work step, independently of
// process generation or lease token. Retried effects retain their request IDs.
function unitId(actorId, unit) {
  return digest('company-pulse-v1', actorId, unit.kind, unit.message?.id ?? unit.task?.id ?? unit.goal.id,
    unit.task?.workStep ?? unit.goal?.taskCount ?? 0);
}
async function choose(actor, execute, workerId, now) {
  let queues = await execute('worker.poll', { workerId, leaseMs });
  if (queues.inbox?.delivery) return { kind:'message', ...queues.inbox };
  while (queues) {
    const candidate = await chooseFromPage(actor, execute, queues, now);
    if (candidate) return candidate;
    queues = queues.next && Object.values(queues.next).some(Boolean)
      ? await execute('worker.poll',{workerId,leaseMs,continuation:true,after:queues.next}) : null;
  }
  return null;
}

async function chooseFromPage(actor, execute, queues, now) {
  for (const [kind, rows, field] of [
    ['review',queues.reviews,'task'], ['plan',queues.unplanned,'goal'],
    ['task',queues.readyTasks,'task'], ['close',queues.closable,'goal'],
  ]) {
    for (const row of rows ?? []) {
      const unit = { kind, [field]: row };
      const id = unitId(actor.id, unit);
      const { entry } = await execute('journal.get', { id });
      if (entry.retryAt > now() || entry.failures >= 3 || entry.steps.at(-1)?.result?.finished) continue;
      if (kind === 'task') {
        try {
          const claim = await execute('task.claim', { taskId:row.id, requestId:randomUUID() });
          Object.assign(unit, claim);
        } catch (error) { if (error.status === 409) continue; throw error; }
      }
      return { ...unit, entry };
    }
  }
  return null;
}

async function contextFor(actor, unit, execute) {
  const { agents } = await execute('directory.list', {});
  const people = agents.filter(person => person.desiredState !== 'fired').map(employee);
  const ctx = { kind:unit.kind, agent:people.find(person => person.id === actor.id) ?? employee(actor), directory:people };
  if (unit.kind === 'message') {
    ctx.conversation = pick(unit.conversation, ['id','title','type','members']);
    ctx.message = message(unit.message);
    ctx.history = (unit.history ?? []).slice(-16).map(row => ({ ...message(row), text:row.text.slice(0,2000) }));
  } else {
    ctx.goal = goal(unit.goal ?? (await execute('goal.get', { goalId:unit.task.goalId })).goal);
    if (unit.task) ctx.task = task(unit.task);
    if (unit.kind === 'close') {
      let after;
      ctx.results = [];
      ctx.verifiedTaskCount = 0;
      do {
        const page = await execute('task.list', { goalId:ctx.goal.id,limit:24,...(after && {after}) });
        for (const row of page.tasks) {
          if (row.status === 'done' && row.review?.decision === 'accept' && row.evidence?.length) ctx.verifiedTaskCount++;
          if (ctx.results.length < 16) ctx.results.push({ id:row.id,title:row.title,status:row.status,
            review:row.review?.note?.slice(0,500),progress:row.progress?.slice(0,500),
            evidence:row.evidence?.slice(0,3).map(line => line.slice(0,350)) });
        }
        after = page.next;
      } while (after);
      ctx.partialResults = ctx.goal.taskCount > ctx.results.length;
    }
    if (ctx.task?.dependencies?.length) {
      const rows = await Promise.all(ctx.task.dependencies.slice(0,8).map(async taskId => {
        try { return (await execute('task.get', { taskId })).task; }
        catch (error) { if ([403,404].includes(error.status)) return { id:taskId }; throw error; }
      }));
      ctx.dependencies = rows.map(row => ({ id:row.id, title:row.title, status:row.status,
        evidence:row.evidence?.slice(0,3).map(value => value.slice(0,500)) }));
    }
  }
  ctx.allowed = permitted(ctx);
  return ctx;
}

function applyDecision({ unit, ctx, execute, browse, signal, requestId }, { op, input }) {
  const key = suffix => digest(requestId, suffix);
  const call = (name, args) => execute(name, { ...args, requestId: key(name) });
  const receipt = (result, finished = false) => ({ ...result, ...(finished && { finished:true }) });
  return withSpan('tool.execute', { action:op.split('.').at(-1) }, async () => {
    if (!ctx.allowed.includes(op)) return { error:'This action is outside the scope of this work.' };
    if (['reply','pass'].includes(op)) {
      if (unit.kind === 'message') await execute('deliveries.ack', { ...deliveryKey(unit), ...(op === 'reply' && { reply:input.text }) });
      return receipt({}, true);
    }
    if (op === 'browse') {
      const page = await browse(input.url, { signal });
      return { url:page.url, title:String(page.title ?? '').slice(0,300), text:String(page.text ?? '').slice(0,4000) };
    }
    if (op === 'goal.create') {
      const created = await call(op, { ...input, accountableId:input.accountableId || ctx.agent.id });
      return { goal:goal(created.goal) };
    }
    if (op === 'task.create' || op === 'employee.hire') {
      if (ctx.goal && input.goalId && input.goalId !== ctx.goal.id) return { error:'That task belongs to a different goal.' };
      let person;
      if (op === 'employee.hire') {
        if (unit.kind === 'plan' && !input.goalId) return { error:'Specify the linked first task while planning a goal.' };
        if (input.title?.length > 320 || input.acceptance?.length > 4000) return { error:'The proposed first task exceeds its size limit.' };
        if (input.goalId) await execute('goal.get',{goalId:input.goalId});
        person = employee((await call(op, { role:input.role })).employee);
        if (!input.goalId) return { employee:person };
      }
      const args = { goalId:input.goalId, assigneeId:person?.id ?? input.assigneeId,
        title:input.title, acceptance:input.acceptance, dependencies:input.dependencies ?? [],
        ...(unit.kind === 'plan' && !person && { ifUnplanned:true }) };
      const created = await call('task.create', args);
      return receipt({ task:task(created.task), ...(person && { employee:person }) }, ['plan','close'].includes(unit.kind));
    }
    if (op === 'employee.fire') return { employee:employee((await call(op,input)).employee) };
    if (op === 'conversations.list') {
      const page = await execute(op,{limit:30});
      return { conversations:page.conversations.map(row => pick(row,['id','title','type'])) };
    }
    if (op === 'group.send') {
      const { conversation } = await execute('conversations.get',{conversationId:input.conversationId});
      if (conversation.type !== 'group') return { error:'Choose a group conversation.' };
      const { message } = await call('messages.post', input);
      return { conversationId:conversation.id,messageId:message.id };
    }
    if (op === 'dm.send' || op === 'group.create') {
      const group = op === 'group.create';
      const { conversation } = group ? await call('conversations.group', { title:input.title, members:input.members })
        : await execute('conversations.dm', { peerId:input.peerId });
      const responders = group ? input.responders : (input.requestReply && input.peerId !== 'owner' ? [input.peerId] : []);
      const result = await call('messages.post', { conversationId:conversation.id, text:input.text, responders });
      return { conversationId:conversation.id, messageId:result.message.id };
    }
    if (op.startsWith('memory.')) {
      const args = { conversationId:ctx.conversation.id };
      if (op === 'memory.save') {
        const saved = await call(op,{ ...args, text:input.text, sourceMessageId:ctx.message.id });
        return { id:saved.memory.id };
      }
      return { memories:(await execute(op,args)).memories.slice(0,12).map(row => ({ id:row.id, text:row.text.slice(0,600) })) };
    }
    if (op === 'task.review') {
      if (input.decision === 'accept' && !ctx.task.evidence?.length) return { error:'The task has no submitted evidence to accept.' };
      const reviewed = await call(op, { ...input,taskId:unit.task.id });
      return receipt({ taskId:reviewed.task.id, status:reviewed.task.status },true);
    }
    if (op === 'goal.close') {
      if (!ctx.goal.taskCount || ctx.goal.taskCount !== ctx.verifiedTaskCount) return { error:'A submitted result and independent acceptance are required for each task.' };
      return receipt({ goal:goal((await call(op,{goalId:unit.goal.id})).goal) },true);
    }
    const result = await call(op,{ ...input, taskId:unit.task.id, claimToken:unit.claimToken, ...(op === 'task.progress' && { release:true }) });
    return receipt({ taskId:result.task.id, status:result.task.status },true);
  });
}

function deliveryKey(unit) {
  return pick(unit.delivery, ['messageId','conversationId','token']);
}

export async function runCompanyPulse({ actor, execute:command, decide, browse, signal:parentSignal,
  mode = 'bedrock', workerId = actor.id, now = Date.now }) {
  const deadline = AbortSignal.timeout(120_000);
  const signal = parentSignal ? AbortSignal.any([parentSignal,deadline]) : deadline;
  const execute = (op,input) => { signal.throwIfAborted(); return command(op,input,signal); };
  if (!['local','bedrock'].includes(mode)) throw new Error('Invalid company worker mode.');
  decide ??= mode === 'local' ? localCompanyDecision : companySdkDecision;
  const unit = await choose(actor,execute,workerId,now);
  if (!unit) return 'idle';
  const id = unitId(actor.id,unit);
  const kind = ['plan','close'].includes(unit.kind) ? 'goal' : unit.kind;
  return withSpan('work.process', { work_id:id, agent_id:actor.id, work_kind:kind,
    attempt:unit.delivery?.attempts ?? unit.task?.attempt }, async () => {
    const attemptId = randomUUID();
    try {
      if (unit.delivery) await execute('deliveries.stage', { ...deliveryKey(unit), plan:{ journalId:id } });
      const ctx = await contextFor(actor,unit,execute);
      let entry = unit.entry ?? (await execute('journal.get', { id })).entry;
      for (let index = 0; index < maxSteps; index++) {
        const prior = entry.steps[index];
        if (prior?.result) { if (prior.result.finished) return 'worked'; continue; }
        if (!prior) {
          const steps = entry.steps.map(step => ({ op:step.decision.op, input:step.decision.input, result:step.result }));
          const choice = checkCompanyDecision(await decide({ ...ctx, steps, remainingDecisions:maxSteps-index },signal));
          entry = (await execute('journal.stage',{ id,index,decision:choice })).entry;
        }
        let result;
        try {
          result = await applyDecision({ unit,ctx,execute,browse,signal,requestId:digest(id,index) },entry.steps[index].decision);
        } catch (error) {
          // Retry ambiguous writes using the staged input. A definitive policy or
          // validation denial can inform the next decision without a fake reply.
          if (![400,403,404,409,422].includes(error.status) || error.code === 'MANAGER_DENIED') throw error;
          result = { error:'The service declined this action (' + error.status + ').' };
        }
        entry = (await execute('journal.confirm',{id,index,result})).entry;
        if (entry.steps[index].result.finished) return 'worked';
      }
      throw new Error('Company decision step limit reached.');
    } catch (error) {
      if (!parentSignal?.aborted) {
        const { entry } = await command('journal.fail',{id,attemptId,kind:unit.kind,
          workId:unit.message?.id ?? unit.task?.id ?? unit.goal.id});
        if (unit.delivery) await command('deliveries.release',{ ...deliveryKey(unit), terminal:entry.failures >= 3 });
        else if (unit.kind === 'task' && entry.failures >= 3) await command('task.block',{ taskId:unit.task.id,
          claimToken:unit.claimToken,note:'Execution could not complete after repeated attempts.',requestId:digest(id,'retry-limit') });
      }
      throw error;
    }
  }, { links:[unit.delivery?.traceparent ? { traceparent:unit.delivery.traceparent }
    : unit.task?.traceContext ?? unit.goal?.traceContext] });
}

export async function runCompanyResident({ actor, execute, workerId, browse, signal, now = Date.now,
  wait = (ms,s) => sleep(ms,undefined,{signal:s}), reportFailure = () => {} }) {
  let heartbeat = 0, failures = 0;
  while (!signal.aborted) {
    let delay = 30_000;
    try {
      const state = await runCompanyPulse({ actor,execute,workerId,browse,signal,now });
      delay = state === 'worked' ? 1000 : 30_000;
      if (now() >= heartbeat) {
        const { active } = await execute('worker.heartbeat',{ summary:state,nextPulseAt:now()+delay },signal);
        if (!active) return;
        heartbeat = now()+120_000;
      }
      failures = 0;
    } catch (error) {
      if (signal.aborted || error.code === 'MANAGER_DENIED') return;
      failures++;
      reportFailure({category:'company_worker',attempt:failures});
      if (failures >= 8) throw new Error('Company worker could not reach a healthy pulse.');
      delay = Math.min(30_000,2 ** failures * 1000);
    }
    try { await wait(delay,signal); } catch (error) { if (!signal.aborted) throw error; }
  }
}
