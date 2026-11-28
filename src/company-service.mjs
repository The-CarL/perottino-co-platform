import { createHash, randomUUID } from 'node:crypto';
import { createConversations } from './conversations.mjs';
import { createWork } from './company-work.mjs';
import { makeCompanyJournal } from './company-journal.mjs';
import { deliverNextGoalNotice } from './company-notifications.mjs';
import { eventRows } from './company-events.mjs';

import { createCompanyFiles } from './company-files.mjs';
import { createSettings } from './company-settings.mjs';
import { createKnowledge } from './company-knowledge.mjs';
import { createGovernance } from './company-governance.mjs';
import { createCompanyMail } from './company-mail.mjs';
import { createInfrastructure } from './company-infrastructure.mjs';
import { createProjects } from './company-projects.mjs';

function problem(status, message) { return Object.assign(new Error(message), { status }); }
function requireOwner(actor) { if (actor !== 'owner') throw problem(403, 'Owner access required.'); }
function requireAgent(actor) { if (actor === 'owner') throw problem(403, 'Employee access required.'); }
function uniqueRequest(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw problem(400, 'Supply a unique requestId.');
  return value;
}
function paging(input) {
  const { limit = 40, after } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (after !== undefined && (typeof after !== 'string' || !after.length || after.length > 256))) throw problem(400, 'Invalid page.');
  return { limit, ...(after && { after }) };
}
function value({ pk, sk, version, ...rest }) { return rest; }
function profile(row) {
  if (!row) throw problem(404, 'Employee not found.');
  const { id, name, handle, role, managerId, desiredState = 'active', canHire } = row;
  const activeStatus = row.taskArn ? 'Task registered' : row.taskArn === null ? 'Waiting for a Fargate task' : 'Active';
  return { id, name, handle, role, managerId: managerId ?? null, canHire: Boolean(canHire), desiredState,
    runtimeStatus: row.runtimeStatus ?? (desiredState === 'active' ? activeStatus : desiredState) };
}

export function createCompanyService({ records, store, control, heartbeat, adapters = {} }) {
  const employee = id => store.employee(id);
  const conversations = createConversations({ records, employee });
  async function canReadSource(actor, source) {
    try { await conversations.execute(actor,'messages.get',source); return true; }
    catch (error) { if ([403,404].includes(error.status)) return false; throw error; }
  }
  const governance = createGovernance({records,store});
  const files = adapters.blobs && createCompanyFiles({records,blobs:adapters.blobs,employee});
  const settings = createSettings({records,employee,modelIds:adapters.modelIds ?? [process.env.PEROTTINO_BEDROCK_MODEL || 'us.openai.gpt-6-sol']});
  const mail = createCompanyMail({records,store,...adapters.mail,transport:adapters.mailTransport?.(records)});
  const work = createWork({ records, employee, canReadSource, canUseMailSource:mail.canUseSource });
  const projects = createProjects({records,store,work,git:adapters.git,
    getBuild:async (actor,input)=>(await deployments()?.status(actor,input))?.build});
  const infrastructure=createInfrastructure({records,projects,provider:adapters.infrastructure});
  const knowledge = createKnowledge({records,employee,files,conversations,projects});
  const browser = adapters.browser?.({records,employee,files});
  const deployments = () => adapters.deployments?.({records,projects,governance});
  const meter = adapters.meter?.({records,governance,settings});
  async function directoryProfile(row) {
    const person=profile(row);
    return {...person,canHire:await governance.canHire(person.id),soulPath:'agents/'+person.handle+'/SOUL.md',
      email:person.handle+'@'+(adapters.mail?.domain ?? 'company.invalid')};
  }
  const journal = makeCompanyJournal({ records });
  async function directory(pulses) {
    const rows = store.listEmployees ? await store.listEmployees() : await Promise.all((await store.directory()).map(person => employee(person.id)));
    const agents = await Promise.all(rows.map(directoryProfile));
    if (pulses && store.getPulse) {
      for (let i = 0; i < rows.length; i += 16) {
        await Promise.all(rows.slice(i,i + 16).map(async (row, j) => {
          const pulse = await store.getPulse(row.id);
          if (pulse?.generation === row.generation && Number.isFinite(pulse.at)) {
            agents[i+j].lastPulseAt = new Date(pulse.at).toISOString();
            agents[i+j].pulseState = ['idle','worked','busy'].includes(pulse.summary) ? pulse.summary : 'unknown';
          }
        }));
      }
    }
    return { agents };
  }
  async function activity(input) {
    const page = await records.list('work-events', paging(input));
    return { events: page.items.map(value), ...(page.next && { next: page.next }) };
  }
  async function memory(actor, op, input) {
    const { conversation } = await conversations.execute(actor, 'conversations.get', { conversationId: input.conversationId });
    const employeeId = actor === 'owner' ? input.employeeId : actor;
    if (!conversation.members.includes(employeeId) || employeeId === 'owner') throw problem(404, 'Employee memory unavailable.');
    const pk = 'conversation-memory#' + conversation.id + '#' + employeeId;
    if (op === 'memory.list') {
      const page = await records.list(pk, paging(input));
      return { memories: page.items.map(value), ...(page.next && { next: page.next }) };
    }
    if (op !== 'memory.save') throw problem(404, 'Unknown memory operation.');
    requireAgent(actor);
    const { text, sourceMessageId } = input;
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw problem(400, 'Invalid memory.');
    await conversations.execute(actor, 'messages.get', { conversationId: conversation.id, messageId: sourceMessageId });
    const id = createHash('sha256').update(uniqueRequest(input.requestId)).digest('hex');
    const result = { id, employeeId, conversationId: conversation.id, sourceMessageId, text: text.trim(), createdAt: new Date().toISOString() };
    if (await records.transact([{ pk, sk: id, expect: null, value: result }, ...eventRows('memory.saved', {actor,conversationId:conversation.id}, pk+id)]))
      return { memory: result };
    const previous = await records.get(pk,id);
    if (previous?.text !== result.text || previous.sourceMessageId !== sourceMessageId) throw problem(409,'Memory request already used.');
    return { memory: value(previous) };
  }
  async function execute(actor, op, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof op !== 'string' ||
        ['actor','callerId','capability','binding','__proto__','constructor','prototype'].some(key => Object.hasOwn(input,key)))
      throw problem(400,'Invalid company command.');
    if (actor !== 'owner' && (await employee(actor))?.desiredState !== 'active') throw problem(403,'Employee access denied.');
    if (op === 'directory' || op === 'directory.list') return directory(actor === 'owner');
    if (op === 'directory.self') { requireAgent(actor); const row = await employee(actor); if(files) await files.ensureSoul(row); return { employee: await directoryProfile(row) }; }
    if (op.startsWith('files.') || op==='soul.get') {
      if(!files) throw problem(503,'Corporate files storage unavailable.');
      return files.execute(actor,op,input);
    }
    if(op.startsWith('settings.')) return settings.execute(actor,op,input);
    if(op.startsWith('knowledge.')) return knowledge.execute(actor,op,input);
    if(op.startsWith('mail.')) return mail.execute(actor,op,input);
    if(op.startsWith('project.')) return projects.execute(actor,op,input);
    if(op.startsWith('browser.') && browser) {
      if(actor!=='owner' && ['browser.document','browser.open','browser.start','browser.act','browser.navigate','browser.input','browser.download'].includes(op) &&
        !(await settings.effective(actor,{})).settings.networkAccess) throw problem(403,'Network access is disabled for this employee.');
      return browser.execute(actor,op,input);
    }
    if(op.startsWith('infra.') && ['provision','status','list','remove'].includes(op.slice(6))) return infrastructure[op.slice(6)](actor,input);
    if(op.startsWith('delivery.') && adapters.deployments && ['build','preview','release','rollback','status','withdraw','expire'].includes(op.slice(9)))
      return deployments()[op.slice(9)](actor,input);
    if(op.startsWith('budget.model.') && meter) { requireAgent(actor);return meter.execute(actor,op,input); }
    if(['budget.settle','budget.reserve','budget.release'].includes(op)) throw problem(403,'Trusted metering required.');
    if(/^(policy|promotion|grant|budget|governance)\./.test(op)) return governance.execute(actor,op,input);
    if (op === 'company.overview') {
      requireOwner(actor);
      const [roster, goals, tasks, feed] = await Promise.all([directory(true), work.execute(actor,'goal.list',{limit:100}),
        work.execute(actor,'task.list',{limit:100}), activity({limit:50})]);
      return { ...roster, goals:goals.goals, tasks:tasks.tasks, events:feed.events,
        more: { goals: Boolean(goals.next), tasks: Boolean(tasks.next), events: Boolean(feed.next) } };
    }
    if (op === 'admin.activity') {
      requireOwner(actor);
      const opts = paging(input);
      if (!await records.transact(eventRows('admin.activity_read',{actor},randomUUID()))) throw problem(503,'Could not record administrative access.');
      const page = await records.list('company-events',opts);
      return {events:page.items.map(value),...(page.next && {next:page.next})};
    }
    if (op === 'activity.list') { requireOwner(actor); return activity(input); }
    if (op.startsWith('employee.') && /^(hire|fire|pause|resume)$/.test(op.slice(9))) {
      uniqueRequest(input.requestId);
      if (op === 'employee.pause' || op === 'employee.resume') requireOwner(actor);
      const perform=permit=>control(actor,op,input,permit);
      const { employee: affected } = op==='employee.hire' ? await governance.hire(actor,input,perform) :
        op==='employee.fire' ? await governance.fire(actor,input,perform) : await perform();
      if(op==='employee.hire' && files) await files.ensureSoul(affected);
      const kind = {hire:'hired',fire:'fired',pause:'paused',resume:'resumed'}[op.slice(9)];
      const rows = eventRows('employee.'+kind,{actor,employeeId:affected.id,status:affected.desiredState},input.requestId);
      if (!await records.transact(rows) && !await records.get(rows[0].pk,rows[0].sk)) throw problem(503,'Retry the employee action.');
      return { employee:await directoryProfile(affected) };
    }
    if (op.startsWith('memory.')) return memory(actor,op,input);
    if (op.startsWith('journal.')) {
      requireAgent(actor);
      if (op === 'journal.fail' && ['plan','close','task','review'].includes(input.kind)) {
        const type = ['plan','close'].includes(input.kind) ? 'goal' : 'task';
        const resource = (await work.execute(actor,type+'.get',{[type+'Id']:input.workId}))[type];
        return journal.execute(actor,op,{...input,workId:resource.id});
      }
      return journal.execute(actor,op,input);
    }
    if (op === 'worker.poll') {
      requireAgent(actor);
      const cursors = input.after ?? {};
      if (typeof cursors !== 'object' || Array.isArray(cursors) || Object.keys(cursors).some(k=>!['review','plan','task','close'].includes(k)))
        throw problem(400,'Invalid queue cursors.');
      const runtimeSettings=await settings.effective(actor,{});
      if (input.continuation !== true) {
        await deliverNextGoalNotice({actor,records,conversations,mail});
        const inbox = await conversations.execute(actor,'deliveries.claim',input);
        if (inbox.delivery) return { inbox,runtimeSettings };
        const incoming=await mail.execute(actor,'mail.claim',input);
        if(incoming.delivery) return {mail:incoming,runtimeSettings};
      }
      function queue(key,op,args) {
        if (input.continuation === true && !cursors[key]) return {};
        return work.execute(actor,op,{...args,limit:8,...(cursors[key] && {after:cursors[key]})});
      }
      const [ready,reviews,unplanned,closable] = await Promise.all([
        queue('task','task.list',{assigneeId:actor,available:true}),
        queue('review','task.list',{reviewerId:actor,status:'submitted'}),
        queue('plan','goal.list',{accountableId:actor,unplanned:true}),
        queue('close','goal.list',{accountableId:actor,closable:true}),
      ]);
      const next = Object.fromEntries([['task',ready],['review',reviews],['plan',unplanned],['close',closable]]
        .filter(([,page])=>page.next).map(([key,page])=>[key,page.next]));
      return { runtimeSettings,readyTasks:ready.tasks ?? [],reviews:reviews.tasks ?? [],unplanned:unplanned.goals ?? [],
        closable:closable.goals ?? [],...(Object.keys(next).length && {next}) };
    }
    if (op === 'worker.heartbeat') {
      requireAgent(actor);
      if (!['idle','worked','busy'].includes(input.summary) || !Number.isSafeInteger(input.nextPulseAt) || input.nextPulseAt < 0)
        throw problem(400,'Invalid heartbeat.');
      return { active: heartbeat ? await heartbeat({summary:input.summary,nextPulseAt:input.nextPulseAt}) : true };
    }
    if (op.startsWith('deliveries.') && op !== 'deliveries.status') requireAgent(actor);
    if (/^(?:conversations|messages|admin|deliveries)\./.test(op)) return conversations.execute(actor,op,input);
    if (/^(?:goal|task)\./.test(op)) return work.execute(actor,op,input);
    throw problem(404,'Unknown company operation.');
  }
  return { execute };
}
