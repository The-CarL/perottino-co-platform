import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHubProjects, createRemoteProjectGit, handler } from '../src/project-git.mjs';
import { branchFor, pathFor, repository } from '../src/project-source.mjs';

const hash=x=>createHash('sha1').update(JSON.stringify(x)).digest('hex');
const base=hash('initial commit'), root=hash('initial tree');
const job={agentId:'engineer',taskId:'task-01',projectId:'p-'+'1'.repeat(32),jobId:'j-'+'2'.repeat(32),baseSha:base,
  createdAt:'2026-01-01T00:00:00.000Z',files:[{path:'public/index.html',content:'Hi'}]};
const reply=(body,status=200)=>Response.json(body,{status});
function mock() {
  const calls=[],refs=new Map(),prs=new Map();
  let throwAfterPR=false, privateRepo=true, fullName=repository, symlink=false;
  async function fetchImpl(raw,init) {
    const url=new URL(raw);
    assert.equal(url.origin,'https://api.github.com');assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer test-token-only');
    assert.ok(url.pathname===('/repos/'+repository) || url.pathname.startsWith('/repos/'+repository+'/'));
    const path=url.pathname.slice(('/repos/'+repository).length);
    const body=init.body?JSON.parse(init.body):null;
    calls.push({path,method:init.method,body});
    if (!path) return reply({full_name:fullName,private:privateRepo,default_branch:'main'});
    if (path==='/git/ref/heads/main') return reply({object:{sha:base}});
    if (path==='/git/commits/'+base) return reply({sha:base,tree:{sha:root}});
    if (path==='/git/trees/'+root) return reply({truncated:false,tree:symlink?[{path:'apps',type:'blob',mode:'120000',sha:hash('x')}]:[]});
    if (path==='/git/trees' || path==='/git/commits') return reply({sha:hash(body)},201);
    if (path==='/git/refs') {
      if (refs.has(body.ref)) return reply({},422);
      refs.set(body.ref,body.sha);return reply({},201);
    }
    if (path.startsWith('/git/ref/heads/jobs/')) {
      const ref=path.replace('/git/ref/','refs/');
      return reply({ref,object:{type:'commit',sha:refs.get(ref)}});
    }
    if (path==='/pulls' && init.method==='GET') {
      assert.equal(url.searchParams.get('state'),'all');assert.equal(url.searchParams.get('base'),'main');
      return reply(prs.has(url.searchParams.get('head'))?[prs.get(url.searchParams.get('head'))]:[]);
    }
    if (path==='/pulls' && init.method==='POST') {
      const pr={number:7,head:{ref:body.head,sha:refs.get('refs/heads/'+body.head),repo:{full_name:repository}},
        base:{ref:'main',repo:{full_name:repository}}};
      prs.set('The-CarL:'+body.head,pr);
      if (throwAfterPR) {throwAfterPR=false;throw Error('Connection interrupted after posting');}
      return reply(pr,201);
    }
    assert.fail('Unexpected Git call '+path);
  }
  return {calls,refs,prs,git:()=>createGitHubProjects({getToken:async()=>'test-token-only',fetchImpl}),
    interrupt:()=>{throwAfterPR=true;},publicRepo:()=>{privateRepo=false;},wrongRepo:()=>{fullName='Other/repository';},symlink:()=>{symlink=true;}};
}
test('fixed GitHub REST path builds a project-only tree, reconciles a lost PR, and never mutates main',async()=>{
  const f=mock();assert.equal(await f.git().head(),base);
  f.interrupt();
  await assert.rejects(f.git().deliver(job),/interrupted/);
  const h=await f.git().deliver(job);
  assert.equal(h.pr.url,'https://github.com/'+repository+'/pull/7');assert.equal(f.prs.size,1);
  assert.equal(f.calls.filter(c=>c.path==='/pulls' && c.method==='POST').length,1);
  assert.deepEqual([...f.refs.keys()],['refs/heads/'+branchFor(job)]);
  const trees=f.calls.filter(c=>c.path==='/git/trees');
  assert.deepEqual(trees[0].body.tree,[{path:'public/index.html',content:'Hi',type:'blob',mode:'100644'}]);
  assert.deepEqual(trees[1].body,{base_tree:root,tree:[{path:pathFor(job.projectId),mode:'040000',type:'tree',sha:hash(trees[0].body)}]});
  assert.ok(f.calls.filter(c=>c.path==='/git/commits').every(c=>c.body.message.includes('Task: task-01') && c.body.parents[0]===base));
  await assert.rejects(f.git().deliver({...job,files:[{path:'index',content:'different'}]}),e=>e.status===409);
  assert.equal(f.refs.get('refs/heads/'+branchFor(job)),h.sha);
});
test('project Git accepts the configured public repository and rejects wrong targets, symlinks and unauthorized input before writes',async()=>{
  const f=mock();f.symlink();
  await assert.rejects(f.git().deliver(job),e=>e.status===409);
  assert.ok(!f.calls.some(c=>c.method==='POST'));
  f.publicRepo();assert.equal(await f.git().head(),base);
  f.wrongRepo();await assert.rejects(f.git().head(),e=>e.status===403);
  assert.throws(()=>createGitHubProjects({repository:'org/../untrusted',getToken:()=>''}),e=>e.status===400);
  assert.deepEqual(await handler({operation:'shell'}),{ok:false,status:400});
  const rpc=createRemoteProjectGit({functionName:'fake',client:{send:async command=>{
    const event=JSON.parse(Buffer.from(command.input.Payload));
    assert.equal(event.operation,'deliver');
    assert.ok(!('token' in event.job));assert.ok(!('target' in event.job));
    return {StatusCode:200,Payload:Buffer.from(JSON.stringify({ok:false,status:403}))};
  }}});
  await assert.rejects(rpc.deliver({...job,token:'ignored',target:'untrusted'}),e=>e.status===403);
});
