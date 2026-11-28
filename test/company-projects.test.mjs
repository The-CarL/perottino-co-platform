import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { createWork } from '../src/company-work.mjs';
import { createProjects } from '../src/company-projects.mjs';
import { useCapability } from '../src/company-capabilities.mjs';
import { createLocalProjectGit } from '../src/project-git-local.mjs';
import { sourceFiles } from '../src/project-source.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'company-project-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const repo=join(directory,'projects.git'),db=join(directory,'state.sqlite');
  const people={ceo:{id:'ceo',managerId:null},engineer:{id:'engineer',managerId:'ceo'},unrelated:{id:'unrelated',managerId:'ceo'}};
  const store={employee:async id=>people[id]};
  let count=0,clock=Date.now();
  const time=()=>clock;
  function open(git=createLocalProjectGit({directory:repo}),getBuild) {
    const records=makeSqliteRecords({filename:db});t.after(()=>records.close());
    const work=createWork({records,employee:store.employee,now:time});
    return {...createProjects({records,work,store,git,getBuild,now:time}),work};
  }
  const service=open();
  async function assign() {
    const {goal}=await service.work.execute('owner','goal.create',{accountableId:'ceo',outcome:'An app',successCriteria:'It works',requestId:'g'+(++count)});
    const {task}=await service.work.execute('ceo','task.create',{goalId:goal.id,assigneeId:'engineer',title:'Implement',acceptance:'Code and tests',requestId:'t'+count});
    const {claimToken}=await service.work.execute('engineer','task.claim',{taskId:task.id,requestId:'c'+count});
    return {goalId:goal.id,taskId:task.id,claimToken};
  }
  const first=await assign();
  const {project}=await service.execute('engineer','project.create',{...first,name:'Tides',requestId:'create-tides'});
  return {repo,open,assign,service,people,advance:ms=>{clock+=ms;},projectId:project.id,...first};
}
const files=[{path:'public/index.html',content:'Tide table'},{path:'test/app.test.mjs',content:'export {}'}];
const rejects=(promise,status)=>assert.rejects(promise,e=>e.status===status);
const runGit=promisify(execFile);
async function inspect(repo,...args) {return (await runGit('git',['--git-dir',repo,...args])).stdout.trimEnd();}

test('immutable code, task ownership, repeat PR delivery and a future goal recover through fresh workers',async t=>{
  const f=await fixture(t),write={projectId:f.projectId,taskId:f.taskId,files,requestId:'write'};
  const first=await f.service.execute('engineer','project.commit',write),h=first.handoff;
  assert.equal(h.agentId,'engineer'); assert.equal(h.taskId,f.taskId);assert.equal(h.pr.local,true);
  assert.equal(await inspect(f.repo,'rev-parse','refs/heads/'+h.branch),h.sha);
  assert.equal(await inspect(f.repo,'rev-parse','refs/perottino/reviews/'+h.jobId),h.sha);
  assert.equal(await inspect(f.repo,'show',h.sha+':'+h.path+'/public/index.html'),'Tide table');
  assert.equal(await inspect(f.repo,'rev-parse','main'),h.baseSha);
  const second=f.open();
  assert.deepEqual((await second.execute('engineer','project.commit',write)).handoff,h);
  await rejects(second.execute('engineer','project.commit',{...write,files:[{path:'a',content:'other'}]}),409);
  await rejects(second.execute('unrelated','project.get',{projectId:f.projectId}),404);
  assert.deepEqual((await second.getSnapshot('owner',{...write,commitSha:h.sha})).files,files);
  f.advance(7*24*3600_000);
  const next=await f.assign();
  await rejects(second.execute('engineer','project.commit',{...write,taskId:next.taskId,requestId:'change',baseSha:h.sha}),403);
  await second.execute('ceo','project.attach',{projectId:f.projectId,goalId:next.goalId,requestId:'attach'});
  const change={...write,taskId:next.taskId,requestId:'change',files:[{path:'public/index.html',content:'New tides'}]};
  await rejects(second.execute('engineer','project.commit',change),409);
  const follow=(await second.execute('engineer','project.commit',{...change,baseSha:h.sha})).handoff;
  assert.equal(await inspect(f.repo,'rev-parse',follow.sha+'^'),h.sha);
  assert.equal(await inspect(f.repo,'show',follow.sha+':'+h.path+'/public/index.html'),'New tides');
  assert.equal(await inspect(f.repo,'ls-tree','-r','--name-only',follow.sha),h.path+'/public/index.html');
  const history=await f.open().execute('ceo','project.history',{projectId:f.projectId});
  assert.deepEqual(history.handoffs.map(x=>x.sha),[h.sha,follow.sha]);
  assert.equal((await second.execute('ceo','project.list',{goalId:next.goalId})).projects[0].latestSha,follow.sha);
});
test('an employee can recover from asking for HEAD on a new project and inspect the exact first handoff',async t=>{
  const f=await fixture(t);
  const execute=(op,input)=>f.service.execute('engineer',op,input);
  const worker={unit:{task:{id:f.taskId}}, execute, call:(op,input)=>execute(op,{...input,requestId:'first-commit'})};
  const snapshot={projectId:f.projectId,taskId:f.taskId,commitSha:'HEAD'};
  const newProject=await useCapability('project.snapshot',snapshot,worker);
  assert.match(newProject.error,/initial files.*omit baseSha/);
  const guessedBase={projectId:f.projectId,baseSha:'HEAD',files};
  assert.deepEqual(await useCapability('project.commit',guessedBase,worker),newProject);
  await rejects(useCapability('project.snapshot',snapshot,{...worker,execute:(op,input)=>f.service.execute('unrelated',op,input)}),404);

  const {handoff}=await useCapability('project.commit',{projectId:f.projectId,files},worker);
  assert.equal(await inspect(f.repo,'rev-parse','main'),handoff.baseSha);
  const {latest}=await useCapability('project.snapshot',snapshot,worker);
  assert.deepEqual(latest,{taskId:f.taskId,commitSha:handoff.sha});
  const actual=await useCapability('project.snapshot',{...snapshot,...latest,path:'public/index.html'},worker);
  assert.equal(actual.content,'Tide table');
  await rejects(useCapability('project.snapshot',{...snapshot,commitSha:handoff.sha,taskId:'wrong-task'},worker),404);
});

test('a lost Git response can be reconciled across processes without duplicating the commit or PR',async t=>{
  const f=await fixture(t),git=createLocalProjectGit({directory:f.repo});
  let landed;
  const unreliable={...git,deliver:async job=>{ landed=await git.deliver(job);throw new Error('response lost'); }};
  const command={projectId:f.projectId,taskId:f.taskId,files,requestId:'lost'};
  await assert.rejects(f.open(unreliable).execute('engineer','project.commit',command),/response lost/);
  const recovered=await f.open().execute('engineer','project.commit',command);
  assert.equal(recovered.handoff.sha,landed.sha); assert.equal(recovered.handoff.pr.number,landed.pr.number);
  assert.equal((await f.open().execute('ceo','project.history',{projectId:f.projectId})).handoffs.length,1);
  assert.equal((await inspect(f.repo,'for-each-ref','--format=%(refname)','refs/heads/jobs')).split('\n').length,1);
});
test('only a live, assigned task can create a work branch and path inputs cannot escape its project',async t=>{
  const f=await fixture(t),job={projectId:f.projectId,taskId:f.taskId,files,requestId:'protected'};
  await rejects(f.service.execute('ceo','project.commit',job),403);
  await rejects(f.service.execute('owner','project.commit',job),403);
  f.advance(24*3600_000);
  await rejects(f.service.execute('engineer','project.commit',job),409);
  f.people.engineer.desiredState='fired';
  await rejects(f.service.execute('engineer','project.get',{projectId:f.projectId}),403);
  for(const path of ['../secrets','/index','x/.github/workflows/y','.git/config','p\\..\\q','node_modules/a','/','constructor/f'])
    assert.throws(()=>sourceFiles([{path,content:'x'}]),e=>e.status===400);
  assert.throws(()=>sourceFiles([{path:'dir',content:'a'},{path:'dir/file',content:'b'}]),e=>e.status===400);
  assert.throws(()=>sourceFiles([{path:'big',content:'a'.repeat(65536)}]),e=>e.status===400);
});

async function reviewFixture(t) {
  const f=await fixture(t);
  const write={projectId:f.projectId,taskId:f.taskId,files,requestId:'write'};
  const {handoff}=await f.service.execute('engineer','project.commit',write);
  const target={projectId:f.projectId,taskId:f.taskId,commitSha:handoff.sha};
  const approve={...target,decision:'approve',note:'I checked the source and the tests.',requestId:'approved'};
  const merge={...target,requestId:'merge'};
  const getBuild=async()=>({...target,status:'passed',testsPassed:1,buildId:'b-'+'1'.repeat(32)});
  const result={sha:handoff.sha,mergeSha:'e'.repeat(40),prNumber:handoff.pr.number};
  const git={...createLocalProjectGit({directory:f.repo}),merge:async()=>result};
  const service=f.open(git,getBuild);
  async function submit() {
    await f.service.work.execute('engineer','task.submit',{taskId:f.taskId,claimToken:f.claimToken,
      evidence:['Project handoff '+handoff.sha],requestId:'submit'});
  }
  return {...f,write,handoff,target,approve,merge,getBuild,git,service,result,submit};
}

test('only an independent, assigned peer or designated reviewer can review and merge a project change',async t=>{
  const f=await reviewFixture(t);
  await f.submit();
  const {service,target,approve,merge}=f;
  await rejects(service.execute('engineer','project.review',approve),403);
  await assert.rejects(service.execute('unrelated','project.review',approve),e=>e.status===403||e.status===404);
  await rejects(service.execute('ceo','project.merge',merge),409);

  const {task:qa}=await service.work.execute('ceo','task.create',{goalId:f.goalId,assigneeId:'unrelated',
    title:'Review app code',acceptance:'Inspect the implementation and test results.',requestId:'qa'});
  const peerApproval={...approve,reviewTaskId:qa.id};
  await assert.rejects(service.execute('unrelated','project.review',peerApproval),e=>e.status===403||e.status===409);
  await service.work.execute('unrelated','task.claim',{taskId:qa.id,requestId:'claim-qa'});
  const other=await f.assign();
  const {task:otherTask}=await service.work.execute('ceo','task.create',{goalId:other.goalId,assigneeId:'unrelated',
    title:'Review another project',acceptance:'Review its changes.',requestId:'other-qa'});
  await service.work.execute('unrelated','task.claim',{taskId:otherTask.id,requestId:'claim-other'});
  await rejects(service.execute('unrelated','project.review',{...peerApproval,reviewTaskId:otherTask.id}),403);
  await rejects(service.work.execute('unrelated','task.get',{taskId:f.taskId}),403);
  const {review}=await service.execute('unrelated','project.review',peerApproval);
  assert.equal(review.decision,'approve');
  assert.equal(review.reviewerId,'unrelated');
  assert.deepEqual((await service.execute('unrelated','project.review',peerApproval)).review,review);
  await rejects(service.execute('engineer','project.merge',{...merge,reviewTaskId:qa.id}),403);

  const change={...target,decision:'changes',note:'Improve the empty state.',requestId:'request-changes'};
  const requested=(await service.execute('ceo','project.review',change)).review;
  await rejects(service.execute('unrelated','project.merge',{...merge,reviewTaskId:qa.id}),409);
  await service.execute('unrelated','project.review',peerApproval);
  assert.deepEqual((await service.execute('ceo','project.review.status',target)).review,requested);
  await service.execute('ceo','project.review',{...approve,requestId:'approved-after-fix'});
  f.people.unrelated.desiredState='paused';
  await rejects(service.execute('unrelated','project.merge',{...merge,reviewTaskId:qa.id}),403);
  f.people.unrelated.desiredState='active';
  f.advance(24*3600_000);
  await rejects(service.execute('unrelated','project.merge',{...merge,reviewTaskId:qa.id}),409);
  await service.work.execute('unrelated','task.claim',{taskId:qa.id,requestId:'reclaim-qa'});
  const {merge:receipt}=await service.execute('unrelated','project.merge',{...merge,reviewTaskId:qa.id});
  assert.equal(receipt.status,'merged');
  assert.equal(receipt.mergedBy,'unrelated');
  assert.equal(receipt.sha,f.handoff.sha);
  assert.equal(receipt.mergeSha,f.result.mergeSha);
  assert.equal(receipt.prNumber,f.handoff.pr.number);
  assert.deepEqual((await f.open(f.git,f.getBuild).execute('owner','project.review.status',target)).merge,receipt);
});

test('a failed or mismatched build cannot authorize merge and approval does not carry forward to another SHA',async t=>{
  const f=await reviewFixture(t);
  const pass=await f.getBuild();
  let build=pass,dispatches=0;
  const service=f.open({...f.git,merge:async()=>{dispatches++;return f.result;}},async()=>build);
  await service.execute('ceo','project.review',f.approve);
  for(const denied of [null,{...pass,status:'failed'},{...pass,commitSha:'f'.repeat(40)},{...pass,taskId:'other'},{...pass,projectId:'p-'+'0'.repeat(32)}]) {
    build=denied;
    await rejects(service.execute('ceo','project.merge',f.merge),409);
  }
  build=pass;
  const {handoff:updated}=await service.execute('engineer','project.commit',{...f.write,baseSha:f.handoff.sha,
    files:[{path:'public/index.html',content:'New tide forecast.'}],requestId:'update'});
  await rejects(service.execute('ceo','project.merge',f.merge),409);
  build={...pass,commitSha:updated.sha};
  await rejects(service.execute('ceo','project.merge',{...f.merge,commitSha:updated.sha,requestId:'merge-updated'}),409);
  assert.equal(dispatches,0);
});

test('a definite branch-rule refusal releases the pending merge for a fresh review',async t=>{
  const f=await reviewFixture(t);
  const service=f.open({...f.git,merge:async()=>{throw Object.assign(new Error('Branch protection requires additional checks.'),{status:409});}},f.getBuild);
  await service.execute('ceo','project.review',f.approve);
  await rejects(service.execute('ceo','project.merge',f.merge),409);
  const {review}=await service.execute('ceo','project.review',{...f.approve,decision:'changes',note:'Fix the required check.',requestId:'review-rejection'});
  assert.equal(review.decision,'changes');
  await rejects(service.execute('ceo','project.merge',{...f.merge,requestId:'retry-merge'}),409);
});

test('a pending external merge fences changes; a fresh broker reconciles an ambiguous response',async t=>{
  const f=await reviewFixture(t);
  const {task:peer}=await f.service.work.execute('ceo','task.create',{goalId:f.goalId,assigneeId:'unrelated',
    title:'Review app code',acceptance:'Inspect the proposed change.',requestId:'peer-merge'});
  await f.service.work.execute('unrelated','task.claim',{taskId:peer.id,requestId:'claim-peer'});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const attempts=[];
  const service=f.open({...f.git,merge:async(handoff,actors)=>{
    attempts.push({sha:handoff.sha,...actors});
    entered.resolve();await release.promise;
    throw new Error('Response lost after provider applied the merge.');
  }},f.getBuild);
  await service.execute('ceo','project.review',f.approve);
  const pending=service.execute('ceo','project.merge',f.merge);
  await Promise.race([entered.promise,pending]);
  try {
    await rejects(service.execute('unrelated','project.merge',{...f.merge,reviewTaskId:peer.id,requestId:'concurrent'}),409);
    await rejects(service.execute('ceo','project.review',{...f.approve,decision:'changes',requestId:'too-late'}),409);
    await rejects(service.execute('engineer','project.commit',{...f.write,baseSha:f.handoff.sha,requestId:'during-merge'}),409);
  } finally {
    release.resolve();
  }
  await assert.rejects(pending);
  await rejects(service.execute('ceo','project.review',{...f.approve,decision:'changes',requestId:'after-lost'}),409);
  const recovered=f.open({...f.git,merge:async(handoff,actors)=>{
    attempts.push({sha:handoff.sha,...actors});
    return f.result;
  }},f.getBuild);
  const first=await recovered.execute('unrelated','project.merge',{...f.merge,reviewTaskId:peer.id,requestId:'recover'});
  assert.equal(first.merge.mergedBy,'ceo');
  assert.equal(first.merge.mergeSha,f.result.mergeSha);
  assert.deepEqual(await recovered.execute('ceo','project.merge',f.merge),first);
  const originalAttribution={sha:f.handoff.sha,reviewerId:'ceo',mergedBy:'ceo'};
  assert.deepEqual(attempts,[originalAttribution,originalAttribution]);
});

test('a review is bound to its provider receipt before it can authorize a merge',async t=>{
  const f=await reviewFixture(t);
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),attempts=[];
  const unreliable=f.open({...f.git,publishReview:async(h,metadata)=>{
    attempts.push(metadata);
    await f.git.publishReview(h,metadata);
    entered.resolve();
    await release.promise;
    throw new Error('Lost provider review response');
  }},f.getBuild);
  const first=unreliable.execute('ceo','project.review',f.approve);
  await Promise.race([entered.promise,first]);
  try {
    const {review}=await unreliable.execute('owner','project.review.status',f.target);
    assert.equal(review.decision,'approve');
    assert.equal(review.publicationStatus,'pending');
    assert.equal(review.publication,null);
    await rejects(unreliable.execute('ceo','project.merge',f.merge),409);
    await rejects(unreliable.execute('ceo','project.review',{...f.approve,requestId:'concurrent'}),409);
  } finally { release.resolve(); }
  await assert.rejects(first,/Lost provider review response/);
  const recovered=f.open({...f.git,publishReview:async(h,metadata)=>{
    attempts.push(metadata);
    return f.git.publishReview(h,metadata);
  }},f.getBuild);
  const {review}=await recovered.execute('ceo','project.review',f.approve);
  assert.equal(review.publicationStatus,'published');
  assert.deepEqual(review.publication,{id:review.reviewId,url:null,sha:f.target.commitSha,prNumber:f.handoff.pr.number,state:'COMMENTED'});
  const publicMetadata={reviewId:review.reviewId,reviewerId:'ceo',decision:'approve'};
  assert.deepEqual(attempts,[publicMetadata,publicMetadata]);
  assert.equal((await recovered.execute('ceo','project.merge',f.merge)).merge.sha,f.target.commitSha);
});

test('a public review refusal keeps a change request effective and a later decision can replace it',async t=>{
  const f=await reviewFixture(t);
  await f.service.execute('ceo','project.review',f.approve);
  const denied=f.open({...f.git,publishReview:async()=>{throw Object.assign(new Error('Protected review.'),{status:403});}},f.getBuild);
  const change={...f.approve,decision:'changes',requestId:'changes-rejected'};
  await rejects(denied.execute('ceo','project.review',change),403);
  const rejected=(await denied.execute('owner','project.review.status',f.target)).review;
  assert.equal(rejected.publicationStatus,'refused');
  assert.equal(rejected.decision,'changes');
  await rejects(denied.execute('ceo','project.merge',f.merge),409);
  const fresh=await f.service.execute('ceo','project.review',{...f.approve,requestId:'updated-approval'});
  assert.equal(fresh.review.publicationStatus,'published');
  await rejects(f.service.execute('ceo','project.review',change),409);
});

test('enrolling a separate reviewer allows a fresh native review and preserves the original comment receipt',async t=>{
  const f=await fixture(t), local=createLocalProjectGit({directory:f.repo});
  const repo='company/products';
  let providerState='COMMENTED',reviewNumber=0;
  const git={...local,repo,deliver:async job=>{
    const result=await local.deliver(job);
    return {...result,repo,pr:{number:result.pr.number,url:'https://github.com/'+repo+'/pull/'+result.pr.number}};
  },publishReview:async h=>{
    const id=++reviewNumber;
    return {id,url:h.pr.url+'#pullrequestreview-'+id,sha:h.sha,prNumber:h.pr.number,state:providerState};
  }};
  const service=f.open(git);
  const {project}=await service.execute('engineer','project.create',{goalId:f.goalId,taskId:f.taskId,name:'Native review',requestId:'new'});
  const {handoff}=await service.execute('engineer','project.commit',{projectId:project.id,taskId:f.taskId,files,requestId:'native-commit'});
  const input={projectId:project.id,taskId:f.taskId,commitSha:handoff.sha,decision:'approve',note:'Tested.',requestId:'comment'};
  const original=(await service.execute('ceo','project.review',input)).review;
  assert.equal(original.publication.state,'COMMENTED');
  providerState='APPROVED';
  const native=(await service.execute('ceo','project.review',{...input,requestId:'native'})).review;
  assert.equal(native.publication.state,'APPROVED');
  assert.notEqual(native.publication.id,original.publication.id);
  assert.deepEqual((await service.execute('ceo','project.review',input)).review,original);
  assert.deepEqual((await service.execute('engineer','project.review.status',input)).review,native);
  providerState='CHANGES_REQUESTED';
  await rejects(service.execute('ceo','project.review',{...input,requestId:'wrong-provider-state'}),502);
});
