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
  const calls=[],refs=new Map(),prs=new Map(),reviews=[];
  let throwAfterPR=false, throwAfterMerge=false, throwAfterReview=false, denyMerge=false, privateRepo=true, fullName=repository, symlink=false;
  async function fetchImpl(raw,init) {
    const url=new URL(raw);
    assert.equal(url.origin,'https://api.github.com');assert.equal(init.redirect,'error');
    const auth=init.headers.Authorization;
    assert.ok(['Bearer test-token-only','Bearer reviewer-only','Bearer test-installation'].includes(auth));
    const account=auth==='Bearer test-token-only'?41:59;
    if (url.pathname==='/user' && init.method==='GET') {
      assert.notEqual(auth,'Bearer test-installation');
      return reply({id:account});
    }
    if (url.pathname==='/graphql' && init.method==='POST') {
      assert.equal(account,41);
      const {variables}=JSON.parse(init.body);
      assert.deepEqual(variables,{owner:'The-CarL',repo:'perottino-co-projects',number:7});
      const pr=[...prs.values()][0];
      return reply({data:{repository:{pullRequest:{
        headRefOid:pr.head.sha,baseRefName:pr.base.ref,reviewDecision:pr.decision??null
      }}}});
    }
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
      const pr={number:7,user:{id:41},state:'open',merged:false,draft:false,mergeable:true,mergeable_state:'clean',
        head:{ref:body.head,sha:refs.get('refs/heads/'+body.head),repo:{full_name:repository}},
        base:{ref:'main',repo:{full_name:repository}}};
      prs.set('The-CarL:'+body.head,pr);
      if (throwAfterPR) {throwAfterPR=false;throw Error('Connection interrupted after posting');}
      return reply(pr,201);
    }
    if (path==='/pulls/7') return reply([...prs.values()][0]);
    if (path==='/pulls/7/reviews' && init.method==='GET') {
      const page=Number(url.searchParams.get('page'));
      return reply(reviews.slice((page-1)*100,page*100));
    }
    if (path==='/pulls/7/reviews' && init.method==='POST') {
      const id=1000+reviews.length;
      const state={COMMENT:'COMMENTED',APPROVE:'APPROVED',REQUEST_CHANGES:'CHANGES_REQUESTED'}[body.event];
      if (state!=='COMMENTED') assert.notEqual(account,41);
      const row={id,commit_id:body.commit_id,state,body:body.body,user:{id:account},
        html_url:'https://github.com/'+repository+'/pull/7#pullrequestreview-'+id};
      reviews.push(row);
      if (throwAfterReview) {throwAfterReview=false;throw Error('Connection interrupted after posting review');}
      return reply(row,201);
    }
    if (path==='/pulls/7/merge' && init.method==='PUT') {
      const pr=[...prs.values()][0];
      if (body.sha!==pr.head.sha) return reply({},409);
      if (denyMerge) return reply({},405);
      pr.merged=true;pr.state='closed';pr.merge_commit_sha=hash('merge '+pr.head.sha);
      if (throwAfterMerge) {throwAfterMerge=false;throw Error('Connection interrupted after merge');}
      return reply({merged:true,sha:pr.merge_commit_sha});
    }
    assert.fail('Unexpected Git call '+path);
  }
  return {calls,refs,prs,reviews,interruptReview:()=>{throwAfterReview=true;},
    git:getReviewerToken=>createGitHubProjects({getToken:async()=>'test-token-only',getReviewerToken,fetchImpl}),
    interrupt:()=>{throwAfterPR=true;},interruptMerge:()=>{throwAfterMerge=true;},denyMerge:()=>{denyMerge=true;},
    publicRepo:()=>{privateRepo=false;},wrongRepo:()=>{fullName='Other/repository';},symlink:()=>{symlink=true;}};
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

async function mergeFixture() {
  const f=mock(), git=f.git();
  const h={...await git.deliver(job),projectId:job.projectId,jobId:job.jobId};
  return {f,git,h,pr:[...f.prs.values()][0]};
}
test('merge uses the GitHub PR endpoint with the reviewed SHA and reconciles lost responses',async()=>{
  const {f,git,h,pr}=await mergeFixture();
  const actors={reviewerId:'qa-1',mergedBy:'qa-1',note:'Private review content'};
  f.interruptMerge();
  await assert.rejects(git.merge(h,actors),/interrupted/);
  const result=await git.merge(h,actors);
  assert.deepEqual(result,{sha:h.sha,mergeSha:pr.merge_commit_sha,prNumber:7});
  const writes=f.calls.filter(c=>c.method==='PUT');
  assert.deepEqual(writes,[{path:'/pulls/7/merge',method:'PUT',body:{sha:h.sha,merge_method:'merge',
    commit_message:'Project-Reviewer: qa-1\nProject-Merger: qa-1'}}]);
});
test('merge rejects changed PR bindings, branch rules, drafts, conflicts, and unready checks',async()=>{
  const {f,git,h,pr}=await mergeFixture();
  for (const attrs of [
    {number:8}, {base:{...pr.base,ref:'other'}}, {base:{...pr.base,repo:{full_name:'other/repo'}}},
    {head:{...pr.head,ref:'jobs/foreign'}}, {head:{...pr.head,sha:hash('new commit')}},
    {head:{...pr.head,repo:{full_name:'fork/repo'}}}, {state:'closed'}, {draft:true},
    {mergeable:false}, {mergeable_state:'blocked'},{mergeable_state:'behind'},{decision:'REVIEW_REQUIRED'},{decision:'CHANGES_REQUESTED'}
  ]) {
    const old={...pr,decision:pr.decision};
    Object.assign(pr,attrs);
    await assert.rejects(git.merge(h),e=>e.status===409);
    Object.assign(pr,old);
  }
  pr.mergeable=null;await assert.rejects(git.merge(h),e=>e.status===503);
  await assert.rejects(git.merge({...h,branch:'main'}),e=>e.status===409);
  await assert.rejects(git.merge({...h,repo:'The-CarL/perottino-co-platform'}),e=>e.status===409);
  assert.equal(f.calls.some(c=>c.method==='PUT'),false);
  pr.mergeable=true;f.denyMerge();await assert.rejects(git.merge(h),e=>e.status===409);
  assert.equal(pr.merged,false);
});
test('the remote merge operation sends only the trusted handoff binding and employee attribution',async()=>{
  const {h}=await mergeFixture();
  const receipt={sha:h.sha,mergeSha:hash('merged'),prNumber:h.pr.number};
  const client={send:async command=>{
    const {operation,job:binding,actors}=JSON.parse(Buffer.from(command.input.Payload));
    assert.equal(operation,'merge');
    assert.deepEqual(binding,{projectId:h.projectId,jobId:h.jobId,branch:h.branch,sha:h.sha,pr:{number:h.pr.number},repo:h.repo,path:h.path});
    assert.deepEqual(actors,{reviewerId:'reviewer',mergedBy:'reviewer'});
    return {StatusCode:200,Payload:Buffer.from(JSON.stringify({ok:true,result:receipt}))};
  }};
  const remote=createRemoteProjectGit({functionName:'fake',client});
  const result=await remote.merge({...h,token:'untrusted',target:'main'},{reviewerId:'reviewer',mergedBy:'reviewer',note:'private'});
  assert.deepEqual(result,receipt);
});
test('GitHub review publishes the peer decision on the exact commit and recovers the authenticated COMMENT across pages',async()=>{
  const {f,git,h,pr}=await mergeFixture();
  const decision={reviewerId:'qa-1',decision:'approve',reviewId:'r-'+'e'.repeat(32),note:'Internal discussion'};
  f.interruptReview();
  await assert.rejects(git.publishReview(h,decision),/interrupted/);
  const original=f.reviews[0];
  const writes=f.calls.filter(c=>c.method==='POST' && c.path.endsWith('/reviews'));
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0].body,{event:'COMMENT',commit_id:h.sha,body:original.body});
  assert.match(original.body,/qa-1/);assert.match(original.body,/approved/);
  assert.ok(original.body.includes(h.sha));
  assert.ok(!original.body.includes(decision.note));
  const imposter={...original,user:{id:77},id:900,html_url:original.html_url.replace('1000','900')};
  f.reviews.unshift(imposter,...Array.from({length:99},()=>({})));
  assert.deepEqual(await git.publishReview(h,decision),{id:original.id,url:original.html_url,sha:h.sha,prNumber:7,state:'COMMENTED'});
  assert.equal(f.calls.filter(c=>c.method==='POST' && c.path.endsWith('/reviews')).length,1);
  const changes=await git.publishReview(h,{...decision,decision:'changes',reviewId:'r-'+'a'.repeat(32)});
  assert.equal(changes.sha,h.sha);
  assert.match(f.reviews.at(-1).body,/changes requested/);
  pr.state='closed';
  await assert.rejects(git.publishReview(h,decision),e=>e.status===409);
  pr.state='open';pr.head.sha=hash('changed');
  await assert.rejects(git.publishReview(h,decision),e=>e.status===409);
  assert.equal(f.calls.filter(c=>c.method==='POST' && c.path.endsWith('/reviews')).length,2);
});
test('the remote review boundary drops caller fields and private review notes',async()=>{
  const {h}=await mergeFixture();
  const input={reviewerId:'qa-1',decision:'approve',reviewId:'r-'+'d'.repeat(32)};
  const remote=createRemoteProjectGit({functionName:'fake',client:{send:async command=>{
    const msg=JSON.parse(Buffer.from(command.input.Payload));
    assert.equal(msg.operation,'publishReview');assert.deepEqual(msg.actors,input);
    assert.deepEqual(msg.job.pr,{number:h.pr.number});assert.equal(msg.job.sha,h.sha);
    assert.ok(!JSON.stringify(msg).includes('private text'));
    return {StatusCode:200,Payload:Buffer.from(JSON.stringify({ok:true,result:{id:123}}))};
  }}});
  await remote.publishReview(h,{...input,note:'private text'});
  assert.throws(()=>remote.publishReview(h,{...input,decision:'anything'}),e=>e.status===400);
});
test('a distinct reviewer PAT or scoped installation can submit a native review; author and dismissed approval are refused',async()=>{
  const {f,h}=await mergeFixture();
  const decision={reviewerId:'qa-2',decision:'approve',reviewId:'r-'+'d'.repeat(32)};
  await assert.rejects(f.git(async()=>'test-token-only').publishReview(h,decision),e=>e.status===409);
  assert.equal(f.reviews.length,0);
  const reviewer=f.git(async()=>'reviewer-only');
  const approval=await reviewer.publishReview(h,decision);
  assert.equal(approval.state,'APPROVED');assert.equal(f.reviews[0].user.id,59);
  assert.deepEqual(await reviewer.publishReview(h,decision),approval);
  f.reviews[0].state='DISMISSED';
  await assert.rejects(reviewer.publishReview(h,decision),e=>e.status===409);
  assert.equal(f.reviews.length,1);
  const app=f.git(async()=>({token:'test-installation',actorId:59}));
  const changes=await app.publishReview(h,{...decision,reviewId:'r-'+'a'.repeat(32),decision:'changes'});
  assert.equal(changes.state,'CHANGES_REQUESTED');assert.equal(f.reviews[1].user.id,59);
  await assert.rejects(f.git(async()=>({token:'test-installation',actorId:41})).publishReview(h,decision),e=>e.status===409);
});
