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
  function open(git=createLocalProjectGit({directory:repo})) {
    const records=makeSqliteRecords({filename:db});t.after(()=>records.close());
    const work=createWork({records,employee:store.employee,now:time});
    return {...createProjects({records,work,store,git,now:time}),work};
  }
  const service=open();
  async function assign() {
    const {goal}=await service.work.execute('owner','goal.create',{accountableId:'ceo',outcome:'An app',successCriteria:'It works',requestId:'g'+(++count)});
    const {task}=await service.work.execute('ceo','task.create',{goalId:goal.id,assigneeId:'engineer',title:'Implement',acceptance:'Code and tests',requestId:'t'+count});
    await service.work.execute('engineer','task.claim',{taskId:task.id,requestId:'c'+count});
    return {goalId:goal.id,taskId:task.id};
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
