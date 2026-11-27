import { createHash } from 'node:crypto';
import { eventRows } from './company-events.mjs';
import { createWork } from './company-work.mjs';
import { branchFor, fault, insist, pathFor, projectFormat, shaFormat, sourceFiles, stableId } from './project-source.mjs';

const projects='projects:catalog';
const jobs='projects:jobs';
const byGoal=id=>'projects:goal:'+id;
const handoffs=id=>'projects:history:'+id;
const snapshots=id=>'projects:snapshots:'+id;
const fieldValues=({pk,sk,version,...value})=>value;
function paging(input) {
  const {limit=30,after}=input;
  insist(Number.isInteger(limit) && limit>=1 && limit<=100 && (after===undefined || (typeof after==='string' && after.length>0 && after.length<=180)),400,'Invalid project page.');
  return {limit,...(after && {after})};
}
function request(input) {
  insist(typeof input.requestId==='string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(input.requestId),400,'Invalid project requestId.');
  return input.requestId;
}
function ident(value) {
  insist(typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value),400,'Invalid work identity.');
  return value;
}
const mutation=(pk,sk,expect,value)=>({pk,sk,expect,value});
const next=page=>page.next?{next:page.next}:{};

export function createProjects({records,store,git,work=createWork({records,employee:id=>store.employee(id)}),now=Date.now}) {
  async function active(actor) {
    if (actor==='owner') return;
    const employee=await store.employee(ident(actor));
    insist(employee && (employee.desiredState??'active')==='active',403,'Active employee required.');
  }
  async function goal(actor,goalId) {
    return (await work.execute(actor,'goal.get',{goalId:ident(goalId)})).goal;
  }
  async function project(actor,id) {
    insist(typeof id==='string' && projectFormat.test(id),400,'Invalid project ID.');
    const row=await records.get(projects,id);
    insist(row,404,'Project not found.');
    for (const goalId of row.goalIds) {
      try { await goal(actor,goalId); return row; }
      catch (e) { if (![403,404].includes(e.status)) throw e; }
    }
    throw fault(404,'Project not found.');
  }
  async function claimed(actor,taskId) {
    insist(actor!=='owner',403,'An assigned employee must commit the work.');
    const {task}=await work.execute(actor,'task.get',{taskId:ident(taskId)});
    insist(task.assigneeId===actor,403,'Only the assigned employee can publish this task.');
    insist(task.status==='running' && task.leaseUntil>now(),409,'Claim the task before publishing code.');
    return task;
  }
  async function create(actor,input) {
    const g=await goal(actor,input.goalId);
    const req=request(input);
    const name=typeof input.name==='string'?input.name.trim():'';
    insist(typeof name==='string' && name.length>0 && name.length<=100,400,'Supply a project name.');
    const id=stableId('p',actor,req);
    const existing=await records.get(projects,id);
    if (existing) {
      insist(existing.goalId===g.id && existing.name===name,409,'Project request already used.');
      return {project:fieldValues(existing)};
    }
    insist(g.status==='active',409,'Project goal must be active.');
    if (!['owner','ceo',g.accountableId].includes(actor)) {
      const task=await claimed(actor,input.taskId);
      insist(task.goalId===g.id,403,'Project is outside this task.');
    }
    insist(git?.repo,503,'Projects Git worker is not configured.');
    const value={id,name,goalId:g.id,goalIds:[g.id],ownerId:g.accountableId,createdBy:actor,createdAt:new Date(now()).toISOString(),
      repo:git.repo,path:pathFor(id),latestSha:null,latestTaskId:null,latestHandoff:null};
    const done=await records.transact([
      mutation(projects,id,null,value),mutation(byGoal(g.id),id,null,{id}),
      ...eventRows('project.created',{actor,projectId:id,goalId:g.id},id),
    ]);
    if (!done) {
      const winner=await records.get(projects,id);
      insist(winner && winner.name===name && winner.goalId===g.id,409,'Project request conflict.');
      return {project:fieldValues(winner)};
    }
    return {project:value};
  }
  async function attach(actor,input) {
    const p=await project(actor,input.projectId);
    insist(['owner','ceo',p.ownerId].includes(actor),403,'Project owner required.');
    const g=await goal(actor,input.goalId);
    const req=request(input);
    if (p.goalIds.includes(g.id)) return {project:fieldValues(p)};
    insist(g.status==='active' && p.goalIds.length<64,409,'Cannot attach this goal.');
    const value={...fieldValues(p),goalIds:[...p.goalIds,g.id]};
    const ok=await records.transact([mutation(projects,p.id,p.version,value),mutation(byGoal(g.id),p.id,null,{id:p.id}),
      ...eventRows('project.attached',{actor,projectId:p.id,goalId:g.id},stableId('a',p.id,g.id,req))]);
    if (!ok) {
      const winner=await project(actor,p.id);
      insist(winner.goalIds.includes(g.id),409,'Project changed. Retry attaching the goal.');
      return {project:fieldValues(winner)};
    }
    return {project:value};
  }
  async function list(actor,input) {
    if (input.goalId) {
      const g=await goal(actor,input.goalId);
      const page=await records.list(byGoal(g.id),paging(input));
      const loaded=await Promise.all(page.items.map(row=>records.get(projects,row.id)));
      return {projects:loaded.filter(Boolean).map(fieldValues),...next(page)};
    }
    insist(['owner','ceo'].includes(actor),403,'Select a goal to list its projects.');
    const page=await records.list(projects,paging(input));
    return {projects:page.items.map(fieldValues),...next(page)};
  }
  function receipt(job,result) {
    insist(result && result.repo===git.repo && result.path===pathFor(job.projectId) && result.branch===branchFor(job) &&
      result.baseSha===job.baseSha && shaFormat.test(result.sha) && Number.isSafeInteger(result.pr?.number) && result.pr.number>0,502,'Invalid Git handoff.');
    const pr=result.pr.local===true && git.repo==='local:projects'
      ? {number:result.pr.number,url:null,local:true}
      : {number:result.pr.number,url:'https://github.com/'+git.repo+'/pull/'+result.pr.number};
    insist(result.pr.url===pr.url,502,'Invalid pull request URL.');
    return {projectId:job.projectId,jobId:job.jobId,taskId:job.taskId,agentId:job.agentId,goalId:job.goalId,
      repo:result.repo,path:result.path,branch:result.branch,sha:result.sha,baseSha:job.baseSha,pr,createdAt:job.createdAt};
  }
  async function commit(actor,input) {
    insist(git?.deliver,503,'Projects Git worker is not configured.');
    let p=await project(actor,input.projectId);
    const taskId=ident(input.taskId),files=sourceFiles(input.files),req=request(input);
    const expected=input.baseSha??null;
    insist(expected===null || (typeof expected==='string' && shaFormat.test(expected)),400,'Invalid project base commit.');
    const jobId=stableId('j',actor,p.id,req);
    const signature=createHash('sha256').update(JSON.stringify([taskId,files,expected])).digest('hex');
    let job=await records.get(jobs,jobId);
    if (job) {
      insist(job.signature===signature,409,'Project commit request already used.');
      if (job.handoff) return {project:fieldValues(p),handoff:job.handoff};
    }
    const task=await claimed(actor,taskId);
    insist(p.goalIds.includes(task.goalId),403,'Task does not belong to this project.');
    if (!job) {
      insist(p.latestSha===expected,409,'Project changed. Read the latest commit before editing.');
      const baseSha=expected??await git.head();
      insist(shaFormat.test(baseSha),502,'Invalid source repository head.');
      const value={jobId,projectId:p.id,goalId:task.goalId,agentId:actor,taskId,signature,expected,baseSha,
        createdAt:new Date(now()).toISOString(),branch:branchFor({projectId:p.id,jobId})};
      await records.transact([mutation(jobs,jobId,null,value),
        ...eventRows('project.commit_requested',{actor,projectId:p.id,taskId,goalId:task.goalId,jobId},jobId)]);
      job=await records.get(jobs,jobId);
      insist(job?.signature===signature,409,'Project request conflicted.');
      if (job.handoff) return {project:fieldValues(await project(actor,p.id)),handoff:job.handoff};
    }
    // A separate execution builds precisely this branch, without ever running its contents.
    // A retry after a lost provider response reconciles the same commit, branch, and PR.
    const result=receipt(job,await git.deliver({...fieldValues(job),files}));
    for (let attempt=0;attempt<5;attempt++) {
      [p,job]=await Promise.all([project(actor,p.id),records.get(jobs,jobId)]);
      if (job.handoff) return {project:fieldValues(p),handoff:job.handoff};
      const current=p.latestSha===job.expected;
      const handoff={...result,status:current?'current':'diverged'};
      const summary=current?{...fieldValues(p),latestSha:handoff.sha,latestTaskId:taskId,latestHandoff:handoff}:fieldValues(p);
      const proposed=[mutation(jobs,jobId,job.version,{...fieldValues(job),handoff}),
        mutation(snapshots(p.id),handoff.sha,null,{handoff,files}),
        mutation(handoffs(p.id),job.createdAt+'#'+jobId,null,handoff),
        ...eventRows('project.committed',{actor,projectId:p.id,taskId,jobId,goalId:job.goalId,status:handoff.status},jobId)];
      if (current) proposed.push(mutation(projects,p.id,p.version,summary));
      if (await records.transact(proposed)) return {project:summary,handoff};
    }
    throw fault(409,'Project changed while recording the Git handoff. Retry this request.');
  }
  async function getSnapshot(actor,input) {
    await active(actor);
    const p=await project(actor,input.projectId);
    insist(typeof input.commitSha==='string' && shaFormat.test(input.commitSha),400,'Invalid commit SHA.');
    const taskId=ident(input.taskId),row=await records.get(snapshots(p.id),input.commitSha);
    insist(row && row.handoff.taskId===taskId,404,'Committed project snapshot not found.');
    return {projectId:p.id,taskId,commitSha:row.handoff.sha,ownerId:p.ownerId,files:row.files,testCommand:['node','--test']};
  }
  async function execute(actor,op,input={}) {
    await active(actor);
    switch (op) {
      case 'project.create': return create(actor,input);
      case 'project.attach': return attach(actor,input);
      case 'project.list': return list(actor,input);
      case 'project.get': return {project:fieldValues(await project(actor,input.projectId))};
      case 'project.commit': return commit(actor,input);
      case 'project.snapshot': return getSnapshot(actor,input);
      case 'project.history': {
        const p=await project(actor,input.projectId);
        const page=await records.list(handoffs(p.id),paging(input));
        return {handoffs:page.items.map(fieldValues),...next(page)};
      }
      default: throw fault(404,'Unknown project operation.');
    }
  }
  return {execute,getSnapshot};
}
