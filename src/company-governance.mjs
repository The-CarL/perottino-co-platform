import { createHash } from 'node:crypto';
import { eventRows } from './company-events.mjs';
import { createWork } from './company-work.mjs';
import { maxCompanyEmployees } from './headcount.mjs';

const policyKey = ['governance:policy','company'];
const grantKey = id => ['governance:grants',id];
const budgetKey = id => ['governance:budgets',id];
const proposalKey = id => ['governance:proposals',id];
const reservationKey = id => ['governance:reservations',id];
const permits = new WeakMap();
const moneyLimit = 1_000_000_000_000;
const defaultPolicy = {revision:0,totalBudgetCents:0,allowCeoPromotions:false,maxDirectReports:maxCompanyEmployees,maxAllocationCents:0};
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const error = (status,message,code) => Object.assign(new Error(message), {status,code});
const deny = () => { throw error(403,'Governance authority denied.'); };
const requireThat = (condition,status,message) => { if (!condition) throw error(status,message); };
function id(value) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value),400,'Invalid governance identifier.');
  return value;
}
function text(value,max) {
  requireThat(typeof value === 'string' && !!value.trim() && value.length <= max,400,'Invalid governance text.');
  return value.trim();
}
function integer(value,min,max) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max,400,'Invalid governance limit or amount.');
  return value;
}
function clean(row) {
  if (!row) return null;
  const {pk,sk,version,...data} = row;
  return data;
}
function policyFor(row) {
  // Existing policies predate logical revisions. A legacy ledger remains revision zero until the owner edits it.
  return {...defaultPolicy,...clean(row)};
}
const accounting = Object.freeze({currency:'USD',unit:'cent',
  basis:'Application ledger. Model charges use the configured tariff and reported token counts, or the reserved maximum when usage is unknown. Build attempts use the configured policy charge. AWS invoices can also include hosting, storage, network and other unmetered services.'});
const grantIdFor = grant => grant?.proposalId ?? (grant?.employeeId === 'ceo' ? 'bootstrap' : undefined);
function write([pk,sk],old,value) { return {pk,sk,expect:old?.version ?? null,value}; }
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));
  return value;
}
function account(id,row) {
  return clean(row) ?? {employeeId:id,availableCents:0,reservedCents:0,spentCents:0,delegatedCents:0,receivedCents:0};
}
function grantFor(id,row,policy) {
  if (row) return id === 'ceo' ? {...clean(row),maxDirectReports:policy.maxDirectReports,maxAllocationCents:policy.maxAllocationCents} : clean(row);
  return id === 'ceo' ? {employeeId:id,active:true,projectId:'*',roles:['*'],maxDirectReports:policy.maxDirectReports,
    maxAllocationCents:policy.maxAllocationCents,allocatedCents:0} : null;
}
function canDelegate(grant,policy,amount) {
  requireThat(grant && grant.active,403,'No active hiring grant.');
  const ceiling = grant.employeeId === 'ceo' ? policy.maxAllocationCents : Math.min(grant.maxAllocationCents,policy.maxAllocationCents);
  requireThat(amount === 0 || grant.allocatedCents + amount <= ceiling,409,'Grant allocation ceiling reached.');
}
function authorityScope(input,policy) {
  const roles = input.roles;
  requireThat(Array.isArray(roles) && roles.length > 0 && roles.length <= 12,400,'Specify allowed hiring roles.');
  const normalized = [...new Set(roles.map(role=>text(role,120).toLowerCase()))];
  requireThat(!normalized.includes('*'),400,'Specify individual hiring roles.');
  return {projectId:id(input.projectId),roles:normalized,maxDirectReports:integer(input.maxDirectReports,1,policy.maxDirectReports),
    maxAllocationCents:integer(input.maxAllocationCents,0,policy.maxAllocationCents)};
}

// A permit is a process-local capability created by hire/fire after checking the current grant.
// The store joins its version checks and ledger writes to the directory transaction.
export function employmentWrites(permit,actor,op,employeeId,hire) {
  if (!permit) {
    if (actor !== 'ceo' && actor !== 'owner') deny();
    // A legacy caller cannot bypass adopted governance, including revocation of the bootstrap CEO.
    return [write(policyKey,null,null)];
  }
  const data = permits.get(permit);
  if (!data || data.actor !== actor || data.op !== op) deny();
  if (op === 'employee.hire' && (hire?.requestId !== data.requestId || hire?.role?.trim().toLowerCase() !== data.role)) deny();
  return data.changes(employeeId);
}
export function governanceChanged() {
  return error(409,'Concurrent governance change; retry with the original request ID.','GOVERNANCE_CHANGED');
}

export function createGovernance({records,store}) {
  const get = key => records.get(...key);
  const work = createWork({records,employee:id=>store.employee(id)});
  async function auditTask(actor,taskId,projectId) {
    if (taskId === undefined) return {};
    // Use the same task visibility check as the normal broker before recording attribution.
    const {task} = await work.execute(actor,'task.get',{taskId:id(taskId)});
    if (projectId && /^p-[a-f0-9]{32}$/.test(projectId)) {
      const project = await records.get('projects:catalog',projectId);
      requireThat(project?.goalIds?.includes(task.goalId),409,'Governance task is outside the project.');
    }
    requireThat(task.id===taskId,409,'Incomplete task attribution.');
    if (projectId === undefined && task.goalId) {
      const page = await records.list('projects:goal:'+task.goalId,{limit:2});
      // A task's goal can be attached to several projects. Choose no project unless the link is unambiguous.
      if (page.items.length === 1 && !page.next) return {taskId:task.id,projectId:page.items[0].id};
    }
    return {taskId:task.id};
  }
  async function person(employeeId) {
    const row = await store.employee(id(employeeId));
    requireThat(row && row.desiredState !== 'fired',404,'Employee is unavailable.');
    return row;
  }
  async function managerOrSelf(actor,employeeId) {
    const employee = await person(employeeId);
    if (actor !== 'owner' && actor !== 'ceo' && actor !== employeeId && actor !== employee.managerId) deny();
    return employee;
  }
  async function ledger(actor,op,input) {
    const requestId = id(input.requestId);
    const key = ['governance:actions:'+actor,digest([op,requestId])];
    const signature = digest(ordered(input));
    const prior = await get(key);
    if (prior) requireThat(prior.signature === signature,409,'Governance request ID already used.');
    return {key,prior,resultWrites(result,employeeId,context) {
      const audit = Object.fromEntries(Object.entries({actor,employeeId,...context}).filter(([,v])=>v !== undefined));
      return [write(key,null,{signature,result,audit}),...eventRows(op,audit,requestId)];
    }};
  }
  async function canHire(employeeId) {
    const row = await get(grantKey(employeeId));
    return row?.active ?? (employeeId === 'ceo');
  }
  async function execute(actor,op,input = {}) {
    if (actor !== 'owner') requireThat((await person(actor)).desiredState === 'active',403,'Employee is inactive.');
    if (op === 'budget.get') op = 'governance.get';
    if (op === 'policy.get') return {policy:policyFor(await get(policyKey))};
    if (op === 'governance.get') {
      const employeeId = id(input.employeeId ?? (actor === 'owner' ? 'ceo' : actor));
      await managerOrSelf(actor,employeeId);
      const [p,g,b] = await Promise.all([get(policyKey),get(grantKey(employeeId)),get(budgetKey(employeeId))]);
      const policy = policyFor(p);
      return {grant:grantFor(employeeId,g,policy),budget:account(employeeId,b),policy,accounting};
    }
    if (op === 'promotion.list') {
      const limit = integer(input.limit ?? 40,1,100);
      const page = await records.list('governance:proposals',{limit,...(input.after && {after:id(input.after)})});
      const proposals = [];
      for (const row of page.items) if (actor === 'owner' || actor === 'ceo' || row.employeeId === actor || row.proposedBy === actor ||
        (await store.employee(row.employeeId))?.managerId === actor) proposals.push(clean(row));
      return {proposals,...(page.next && {next:page.next})};
    }
    for (let attempt=0; attempt<10; attempt++) {
      const receipt = await ledger(actor,op,input);
      if (receipt.prior) return {...receipt.prior.result,replayed:true};
      const policyRow = await get(policyKey);
      const policy = policyFor(policyRow);
      const changes = [];
      let result, subject;
      const audit = {policyVersion:policy.revision};
      if (op === 'policy.set') {
        if (actor !== 'owner') deny();
        requireThat(typeof input.allowCeoPromotions === 'boolean',400,'Specify CEO promotion authority.');
        const next = {revision:policy.revision+1,totalBudgetCents:integer(input.totalBudgetCents,0,moneyLimit),allowCeoPromotions:input.allowCeoPromotions,
          maxDirectReports:integer(input.maxDirectReports,1,maxCompanyEmployees),maxAllocationCents:integer(input.maxAllocationCents,0,moneyLimit)};
        requireThat(next.maxAllocationCents <= next.totalBudgetCents,400,'Allocation ceiling exceeds the company budget.');
        const row = await get(budgetKey('ceo')), ceo = account('ceo',row);
        const delta = next.totalBudgetCents-policy.totalBudgetCents;
        requireThat(ceo.availableCents + delta >= 0,409,'The budget is already spent, held or delegated.');
        ceo.availableCents += delta; ceo.receivedCents += delta;
        changes.push(write(policyKey,policyRow,next),write(budgetKey('ceo'),row,ceo));
        result = {policy:next}; subject = 'ceo';
        Object.assign(audit,{policyVersion:next.revision,amountKind:'company-ceiling',amountCents:next.totalBudgetCents});
      } else if (op === 'promotion.propose') {
        subject = id(input.employeeId);
        const candidate = await person(subject);
        if (subject === 'ceo' || (actor !== 'owner' && actor !== subject && actor !== candidate.managerId)) deny();
        // The owner may still consider a proposal when CEO approvals are disabled.
        const scope = authorityScope(input,{maxDirectReports:maxCompanyEmployees,maxAllocationCents:moneyLimit});
        const firstHireCase = text(input.firstHireCase,2000), evidence = input.evidenceTaskIds;
        requireThat(Array.isArray(evidence) && evidence.length >= 1 && evidence.length <= 12,400,'Completed work evidence is required.');
        const evidenceTaskIds = [...new Set(evidence.map(id))];
        for (const taskId of evidenceTaskIds) {
          const task = await records.get('work:tasks',taskId);
          requireThat(task?.assigneeId === subject && task.status === 'done' && task.review?.decision === 'accept' && task.evidence?.length,
            409,'Evidence must reference reviewed work completed by the candidate.');
        }
        const proposal = {id:digest([actor,op,input.requestId]),employeeId:subject,proposedBy:actor,evidenceTaskIds,
          firstHireCase,...scope,status:'pending',createdAt:new Date().toISOString()};
        changes.push(write(proposalKey(proposal.id),null,proposal));
        result = {proposal};
        Object.assign(audit,{managerId:candidate.managerId,proposalId:proposal.id,projectId:proposal.projectId,
          amountKind:'proposed-allocation-ceiling',amountCents:proposal.maxAllocationCents});
      } else if (op === 'promotion.approve') {
        if (actor !== 'owner') {
          if (actor !== 'ceo' || !policy.allowCeoPromotions) deny();
          const ceo = await get(grantKey('ceo'));
          const authority = grantFor('ceo',ceo,policy);
          if (!authority.active) deny();
          changes.push(write(grantKey('ceo'),ceo,authority));
        }
        const key = proposalKey(id(input.proposalId)), old = await get(key);
        requireThat(old,404,'Promotion proposal not found.');
        requireThat(old.status === 'pending',409,'This proposal is already decided.');
        subject = old.employeeId;
        const candidate = await person(subject);
        const scope = authorityScope(old,policy);
        const [g,b] = await Promise.all([get(grantKey(subject)),get(budgetKey(subject))]);
        requireThat(!g?.active,409,'This employee already holds an active hiring grant.');
        requireThat(scope.maxAllocationCents <= account(subject,b).availableCents,409,'Grant exceeds the employee’s available budget.');
        const proposal = {...clean(old),status:'approved',approvedBy:actor,approvedAt:new Date().toISOString()};
        const grant = {employeeId:subject,active:true,...scope,allocatedCents:0,proposalId:proposal.id};
        changes.push(write(policyKey,policyRow,policy),write(key,old,proposal),write(grantKey(subject),g,grant),
          write(budgetKey(subject),b,account(subject,b)));
        result = {proposal,grant};
        Object.assign(audit,{managerId:candidate.managerId,proposalId:proposal.id,grantId:proposal.id,projectId:grant.projectId,
          amountKind:'allocation-ceiling',amountCents:grant.maxAllocationCents});
      } else if (op === 'grant.restore') {
        if (actor !== 'owner' || input.employeeId !== 'ceo') deny();
        await person('ceo');
        const old = await get(grantKey('ceo'));
        requireThat(old && !old.active,409,'CEO hiring authority is already active.');
        const grant = {...clean(old),active:true};
        subject = 'ceo';
        changes.push(write(grantKey(subject),old,grant)); result = {grant};
        audit.grantId = grantIdFor(grant);
      } else if (op === 'grant.revoke') {
        subject = id(input.employeeId);
        const employee = await person(subject);
        if (actor !== 'owner' && !(subject !== 'ceo' && (actor === 'ceo' || actor === employee.managerId))) deny();
        const old = await get(grantKey(subject)), grant = grantFor(subject,old,policy);
        requireThat(grant?.active,409,'This employee has no active grant.');
        grant.active = false;
        changes.push(write(policyKey,policyRow,policy),write(grantKey(subject),old,grant));
        result = {grant};
        Object.assign(audit,{grantId:grantIdFor(grant),projectId:grant.projectId === '*' ? undefined : grant.projectId,managerId:employee.managerId ?? undefined});
      } else if (op === 'budget.allocate') {
        subject = id(input.employeeId);
        const target = await person(subject), from = target.managerId;
        if (!from || (actor !== 'owner' && actor !== from)) deny();
        const amount = integer(input.amountCents,1,moneyLimit);
        const [a,b,g] = await Promise.all([get(budgetKey(from)),get(budgetKey(subject)),get(grantKey(from))]);
        const source = account(from,a), budget = account(subject,b), grant = grantFor(from,g,policy);
        if (actor !== 'owner') {
          canDelegate(grant,policy,amount);
          if (actor !== 'ceo' && budget.projectId !== grant.projectId) deny();
        }
        requireThat(source.availableCents >= amount,409,'Insufficient available budget.');
        source.availableCents -= amount; source.delegatedCents += amount;
        const fundingGrantId = actor === 'owner' ? 'owner' : grantIdFor(grant);
        // A mixed wallet is fungible; a later charge cannot be assigned to just one upstream grant.
        budget.fundingGrantId = budget.receivedCents === 0 || budget.fundingGrantId === fundingGrantId ? fundingGrantId : null;
        budget.availableCents += amount; budget.receivedCents += amount;
        changes.push(write(policyKey,policyRow,policy),write(budgetKey(from),a,source),write(budgetKey(subject),b,budget));
        if (actor !== 'owner') changes.push(write(grantKey(from),g,{...grant,allocatedCents:grant.allocatedCents+amount}));
        result = {budget};
        Object.assign(audit,{grantId:actor === 'owner' ? 'owner' : grantIdFor(grant),projectId:budget.projectId,
          managerId:from,amountKind:'allocation',amountCents:amount});
      } else if (op === 'budget.reclaim') {
        subject = id(input.employeeId);
        // The owner can recover unspent allocations after an employee departs. In-flight holds stay reserved.
        if (actor !== 'owner') deny();
        const target = await store.employee(subject);
        requireThat(target?.managerId,404,'Delegated budget not found.');
        const amount = integer(input.amountCents,1,moneyLimit);
        const [b,a] = await Promise.all([get(budgetKey(subject)),get(budgetKey(target.managerId))]);
        const budget = account(subject,b), source = account(target.managerId,a);
        requireThat(budget.availableCents >= amount && source.delegatedCents >= amount,409,'Funds are already held, delegated or spent.');
        budget.availableCents -= amount; budget.receivedCents -= amount;
        source.availableCents += amount; source.delegatedCents -= amount;
        changes.push(write(budgetKey(subject),b,budget),write(budgetKey(target.managerId),a,source));
        result = {budget};
        Object.assign(audit,{grantId:'owner',projectId:budget.projectId,managerId:target.managerId,
          amountKind:'reclaimed-allocation',amountCents:amount});
      } else if (['budget.reserve','budget.settle','budget.release'].includes(op)) {
        subject = actor === 'owner' ? id(input.employeeId ?? 'ceo') : actor;
        if (op === 'budget.reserve') await person(subject);
        const key = op === 'budget.reserve' ? reservationKey(digest([subject,op,input.requestId])) : reservationKey(id(input.reservationId));
        const [old,b] = await Promise.all([get(key),get(budgetKey(subject))]);
        const budget = account(subject,b);
        let reservation;
        if (op === 'budget.reserve') {
          const amount = integer(input.amountCents,1,moneyLimit);
          requireThat(['model','preview'].includes(input.purpose),400,'Unsupported spending purpose.');
          requireThat(!old,409,'Reservation already exists.');
          requireThat(budget.availableCents >= amount,409,'Insufficient available budget.');
          const requestedProject = input.projectId === undefined ? undefined : id(input.projectId);
          const context = await auditTask(actor,input.taskId,requestedProject);
          const projectId = requestedProject ?? context.projectId ?? (input.taskId === undefined ? budget.projectId : undefined);
          reservation = {id:key[1],employeeId:subject,purpose:input.purpose,amountCents:amount,status:'reserved',
            policyVersion:policy.revision,...(budget.fundingGrantId && {fundingGrantId:budget.fundingGrantId}),
            ...context,...(projectId && {projectId})};
          budget.availableCents -= amount; budget.reservedCents += amount;
        } else {
          requireThat(old?.employeeId === subject,404,'Budget reservation not found.');
          requireThat(old.status === 'reserved',409,'Reservation already finalized.');
          requireThat((input.taskId === undefined || input.taskId === old.taskId) && (input.projectId === undefined || input.projectId === old.projectId),
            409,'Reservation attribution cannot be changed.');
          const actual = op === 'budget.settle' ? integer(input.actualCents,0,old.amountCents) : 0;
          reservation = {...clean(old),status:op === 'budget.settle' ? 'settled':'released',actualCents:actual};
          budget.reservedCents -= old.amountCents; budget.availableCents += old.amountCents-actual; budget.spentCents += actual;
        }
        changes.push(write(key,old,reservation),write(budgetKey(subject),b,budget));
        result = {reservation,budget};
        Object.assign(audit,{resourceId:'budget:'+subject,reservationId:reservation.id,projectId:reservation.projectId,taskId:reservation.taskId,
          policyVersion:reservation.policyVersion ?? 0,fundingGrantId:reservation.fundingGrantId,purpose:reservation.purpose,amountKind:op==='budget.reserve' ? 'hold' :
            op==='budget.release' ? 'released-hold' : 'policy-ledger-charge',
          amountCents:op==='budget.settle' ? reservation.actualCents : reservation.amountCents});
      } else throw error(404,'Unknown governance operation.');
      if (!result.reservation) Object.assign(audit,await auditTask(actor,input.taskId,audit.projectId));
      // The receipt names the exact policy in effect at approval. Finalizing a hold keeps the policy that admitted it.
      if (!['budget.settle','budget.release'].includes(op) && !changes.some(c=>c.pk===policyKey[0] && c.sk===policyKey[1]))
        changes.push(write(policyKey,policyRow,policy));
      if (await records.transact([...changes,...receipt.resultWrites(result,subject,audit)])) return result;
    }
    throw governanceChanged();
  }
  async function employment(actor,op,input,perform) {
    const managerId = actor === 'owner' ? 'ceo' : actor;
    if (op === 'employee.hire' || actor !== 'owner') {
      const manager = await person(managerId);
      if (manager.desiredState !== 'active') deny();
    }
    for (let i=0;i<10;i++) {
      const receipt = await ledger(actor,op,input);
      if (receipt.prior) return {employee:await store.employee(receipt.prior.result.employeeId)};
      const [p,g] = await Promise.all([get(policyKey),get(grantKey(managerId))]);
      const policy = policyFor(p);
      const grant = grantFor(managerId,g,policy);
      if (actor !== 'owner' && !grant?.active) deny();
      const changes = [write(policyKey,p,policy)];
      let childBudget;
      const audit = {policyVersion:policy.revision,managerId};
      if (actor === 'owner' || op === 'employee.hire') audit.grantId = actor === 'owner' ? 'owner' : grantIdFor(grant);
      if (op === 'employee.hire') {
        const role = text(input.role,120).toLowerCase(), projectId = id(input.projectId ?? (managerId === 'ceo' ? 'company' : ''));
        const amount = integer(input.allocationCents ?? 0,0,moneyLimit);
        if (actor !== 'owner' && managerId !== 'ceo' && (grant.projectId !== projectId || !grant.roles.includes(role))) deny();
        const directs = (await store.listEmployees()).filter(e=>e.managerId === managerId && e.desiredState !== 'fired').length;
        if (actor !== 'owner') {
          canDelegate(grant,policy,amount);
          const seats = managerId === 'ceo' ? policy.maxDirectReports : Math.min(policy.maxDirectReports,grant.maxDirectReports);
          requireThat(directs < seats,409,'Direct report limit reached.');
        }
        const b = await get(budgetKey(managerId)), budget = account(managerId,b);
        requireThat(budget.availableCents >= amount,409,'Insufficient available budget.');
        budget.availableCents -= amount; budget.delegatedCents += amount;
        changes.push(write(budgetKey(managerId),b,budget));
        if (grant) changes.push(write(grantKey(managerId),g,{...grant,allocatedCents:grant.allocatedCents+amount}));
        childBudget = {projectId,availableCents:amount,receivedCents:amount,fundingGrantId:audit.grantId};
        Object.assign(audit,{projectId,amountKind:'allocation',amountCents:amount});

      } else {
        const target = await store.employee(id(input.agentId));
        requireThat(target,404,'Employee is unavailable.');
        audit.managerId = target.managerId ?? undefined;
        if (actor !== 'owner') {
          if (target.managerId !== actor) deny();
          changes.push(write(grantKey(managerId),g,grant));
          audit.grantId = grantIdFor(grant);
          if (grant.projectId !== '*') audit.projectId = grant.projectId;
        }
      }
      Object.assign(audit,await auditTask(actor,input.taskId,audit.projectId));
      const permit = {};
      permits.set(permit,{actor,op,requestId:input.requestId,role:op === 'employee.hire' ? input.role.trim().toLowerCase() : undefined,changes(employeeId) {
        if (op === 'employee.fire' && employeeId !== input.agentId) deny();
        return [...changes,...(childBudget ? [write(budgetKey(employeeId),null,{...account(employeeId,null),...childBudget})] : []),
          ...receipt.resultWrites({employeeId},employeeId,audit)];
      }});
      try {
        const result = await perform(permit);
        // A receipt from the older hiring protocol cannot silently adopt new budget terms.
        const committed = (await ledger(actor,op,input)).prior;
        requireThat(committed && committed.result.employeeId === result.employee.id,409,'This employee request predates governance. Use a new request ID.');
        return result;
      }
      catch (err) { if (err.code !== 'GOVERNANCE_CHANGED') throw err; }
      finally { permits.delete(permit); }
    }
    throw governanceChanged();
  }
  return {execute,canHire,hire:(actor,input,perform)=>employment(actor,'employee.hire',input,perform),
    fire:(actor,input,perform)=>employment(actor,'employee.fire',input,perform)};
}
