import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { handler } from '../src/delivery-executor.mjs';
import { createDeployments, createDockerExecutor, expirePreviews, serveDelivery, startLocalDelivery } from '../src/company-deployments.mjs';

const projectId='p-'+'1'.repeat(32), taskId='task-1', commitSha='a'.repeat(40);
const input={projectId,taskId,commitSha,requestId:'req'};
const suite="import test from 'node:test'; import assert from 'node:assert/strict'; import {twice} from '../public/app.mjs'; test('calculation',()=>assert.strictEqual(twice(3),6));";
function snapshot(content='<main>Transit departures</main>') {
  return [{path:'public/index.html',content},{path:'public/app.mjs',content:'export const twice=n=>2*n;'},
    {path:'test/app.test.mjs',content:suite}];
}
const execute=files=>handler({template:'static-site-v1',files});

test('isolated JavaScript compiles generated public assets, imports actual source and tests it',async()=>{
  const files=snapshot().filter(x=>x.path!=='public/index.html');
  files.push({path:'data.json',content:'{"departures":4}'},
    {path:'build.mjs',content:`import stats from './data.json'; export default ()=>[{path:'public/index.html',content:'<p>'+stats.departures+' departures</p>'}];`});
  const result=await execute(files);
  assert.equal(result.status,'passed'); assert.equal(result.testsPassed,1);
  assert.equal(result.files.find(x=>x.path==='public/index.html').content,'<p>4 departures</p>');
  assert.ok(result.files.every(x=>x.path.startsWith('public/')));
  const broken=snapshot();broken[1].content='export const twice=n=>3*n;';
  assert.deepEqual(await execute(broken),{status:'failed',reason:'test_failed',testsPassed:0});
});

test('guest has no process, network, host modules, native bindings or filesystem; slow and asynchronous tests fail closed',async()=>{
  const probe=snapshot();
  probe[2].content="import {test} from 'node:test'; import assert from 'node:assert/strict'; test('isolation',()=>assert.deepStrictEqual([typeof process,typeof fetch,typeof require,typeof read,typeof WebAssembly],Array(5).fill('undefined')));";
  assert.equal((await execute(probe)).status,'passed');
  probe[2].content="import fs from 'node:fs';";
  assert.equal((await execute(probe)).reason,'invalid_module');
  probe[2].content="import {test} from 'node:test'; test('async',async()=>{});";
  assert.equal((await execute(probe)).reason,'test_failed');
  probe[2].content='while(true){}'; assert.equal((await execute(probe)).reason,'time_limit');
  assert.equal((await execute(snapshot().slice(0,2))).reason,'missing_tests');
});

function fixture(policy={},opts={}) {
  const records=makeSqliteRecords({filename:':memory:'});
  const time={value:Date.UTC(2026,0,2)}, builds={count:0};
  const projects={async getSnapshot(actor,i) {
    if(!['owner','engineer'].includes(actor)) throw Object.assign(new Error('Forbidden'),{status:403});
    return {...i,ownerId:'owner',files:snapshot('<main>'+i.commitSha.slice(0,1)+'</main>')};
  }};
  const service=createDeployments({records,projects,origin:opts.origin ?? 'https://example.test',now:()=>time.value,policy,
    execute:async i=>{builds.count++;return handler(i);},...opts});
  return {records,time,builds,service};
}
test('immutable build evidence, preview expiry, budget replay, production authority and rollback',async t=>{
  const actions=[];
  const governance={async execute(actor,op,input){
    actions.push({actor,op,input}); return {reservation:{id:'hold'}};
  }};
  const {records,time,builds,service}=fixture({},{governance});
  t.after(()=>records.close());
  await assert.rejects(()=>service.build('unrelated',input),{status:403});
  const first=await service.build('engineer',input);
  assert.equal(first.status,'passed');assert.equal((await service.build('engineer',input)).buildId,first.buildId);
  assert.equal(builds.count,1);assert.equal(actions.filter(a=>a.op==='budget.reserve').length,1);
  assert.equal(actions.filter(a=>a.op==='budget.settle').length,1);
  const publish={requestId:'pub',projectId,buildId:first.buildId};
  const preview=await service.preview('engineer',{...publish,ttlHours:2});
  assert.deepEqual(await service.preview('engineer',{...publish,ttlHours:2}),preview);
  assert.equal((await serveDelivery(records,{path:new URL(preview.url).pathname},()=>time.value)).body,'<main>a</main>');
  await assert.rejects(()=>service.preview('engineer',{...publish,ttlHours:3}),{status:409});
  await assert.rejects(()=>service.release('engineer',publish),{status:403});
  const production=await service.release('owner',publish);
  await assert.rejects(()=>service.rollback('owner',{projectId,requestId:'early'}),{status:409});
  const second=await service.build('engineer',{...input,requestId:'second',commitSha:'b'.repeat(40)});
  const update=await service.release('owner',{...publish,requestId:'ship',buildId:second.buildId});
  assert.equal(update.url,production.url);assert.equal(update.previousBuildId,first.buildId);
  assert.equal((await serveDelivery(records,{path:new URL(update.url).pathname},()=>time.value)).body,'<main>b</main>');
  const restored=await service.rollback('owner',{projectId,requestId:'undo'});
  assert.equal(restored.buildId,first.buildId);assert.equal(restored.previousBuildId,second.buildId);
  assert.deepEqual(await service.rollback('owner',{projectId,requestId:'undo'}),restored);
  time.value+=2*3600_000;
  assert.equal((await serveDelivery(records,{path:new URL(preview.url).pathname},()=>time.value)).statusCode,404);
  assert.equal(await expirePreviews(records,()=>time.value),1);
  assert.equal(await records.get('PUBLICSITE#PREVIEW',projectId),null);
  assert.equal((await service.status('owner',input)).production.buildId,first.buildId);
});

test('bounded concurrent builds, quota and project-scoped deployment authority',async t=>{
  const {records,service,builds}=fixture({dailyBuilds:1,previews:1,productionAgents:[{agentId:'engineer',projectId}]});
  t.after(()=>records.close());
  const replies=await Promise.all(Array.from({length:8},()=>service.build('engineer',input)));
  assert.equal(builds.count,1); assert.ok(replies.some(r=>r.status==='passed'));
  const first=await service.build('engineer',input);
  const pub={requestId:'pub',projectId,buildId:first.buildId};
  assert.equal((await service.release('engineer',pub)).buildId,first.buildId);
  await assert.rejects(()=>service.build('engineer',{...input,commitSha:'b'.repeat(40)}),{status:429});
  await assert.rejects(()=>service.release('engineer',{...pub,projectId:'p-'+'a'.repeat(32)}),{status:403});
  await assert.rejects(()=>service.preview('engineer',{...pub,ttlHours:169}),{status:400});
});

test('public preview origin serves only the selected public tree and issues isolation headers',async t=>{
  const {records,service,time}=fixture();
  t.after(()=>records.close());
  const server=await startLocalDelivery({records});t.after(server.close);
  time.value=Date.now();
  const result=await service.build('owner',input);
  const preview=await service.preview('owner',{projectId,buildId:result.buildId,requestId:'browser'});
  const base=server.origin+new URL(preview.url).pathname;
  const page=await fetch(base);assert.equal(await page.text(),'<main>a</main>');
  assert.match(page.headers.get('content-security-policy'),/sandbox allow-scripts;/);
  assert.equal((await fetch(base+'app.mjs')).headers.get('content-type'),'text/javascript; charset=utf-8');
  for(const path of ['test/app.test.mjs','%2e%2e%2fprivate','../secret','no.html']) assert.equal((await fetch(base+path)).status,404);
  assert.equal((await fetch(base,{method:'POST'})).status,405);
  assert.equal(await (await fetch(base,{method:'HEAD'})).text(),'');
});

test('packaged offline build executes a generated static app and reports actual failing tests',
  {skip:!process.env.PEROTTINO_DELIVERY_TEST_IMAGE},async()=>{
    const run=createDockerExecutor({image:process.env.PEROTTINO_DELIVERY_TEST_IMAGE});
    const files=snapshot();
    assert.equal((await run({template:'static-site-v1',files})).status,'passed');
    files[2].content="import test from 'node:test'; import assert from 'node:assert/strict'; test('must fail',()=>assert.ok(false));";
    assert.equal((await run({template:'static-site-v1',files})).reason,'test_failed');
  });

test('owner can remove exactly the reviewed live build; stale requests cannot delete a replacement',async t=>{
  const {records,service,time}=fixture();
  t.after(()=>records.close());
  const build=await service.build('engineer',input);
  const act={projectId,requestId:'publish',buildId:build.buildId};
  const prod=await service.release('owner',act);
  const preview=await service.preview('engineer',act);
  await assert.rejects(()=>service.withdraw('engineer',act),{status:403});
  await assert.rejects(()=>service.expire('engineer',act),{status:403});
  await assert.rejects(()=>service.withdraw('owner',{...act,buildId:'b-'+'f'.repeat(32)}),{status:409});
  const done=await service.withdraw('owner',act);
  assert.equal(done.status,'withdrawn');assert.deepEqual(await service.withdraw('owner',act),done);
  assert.equal((await serveDelivery(records,{path:new URL(prod.url).pathname},()=>time.value)).statusCode,404);
  assert.equal((await serveDelivery(records,{path:new URL(preview.url).pathname},()=>time.value)).statusCode,200);
  assert.equal((await service.expire('owner',act)).status,'withdrawn');
  assert.equal((await serveDelivery(records,{path:new URL(preview.url).pathname},()=>time.value)).statusCode,404);
});

test('unknown executor response uses a new budget charge and quota for each retry after the prior run times out',async t=>{
  const attempts=new Set(),settled=new Set();
  const governance={async execute(actor,op,input) {
    if(op==='budget.reserve') attempts.add(input.requestId);
    if(op==='budget.settle') settled.add(input.requestId);
    return {reservation:{id:'hold'}};
  }};
  const {records,time,service}=fixture({dailyBuilds:2},{governance,execute:async()=>{throw Error('test transport');}});
  t.after(()=>records.close());
  await assert.rejects(()=>service.build('engineer',input),/test transport/);
  assert.equal((await service.build('engineer',input)).status,'testing');
  time.value+=30_000;
  await assert.rejects(()=>service.build('engineer',input),/test transport/);
  time.value+=30_000;
  await assert.rejects(()=>service.build('engineer',input),{status:429});
  assert.equal(attempts.size,2); assert.equal(settled.size,2);
});

test('Chromium loads public ES modules and runs the app in an opaque browser origin',
  {skip:!process.env.PEROTTINO_UI_DELIVERY},async t=>{
    const {chromium}=await import('playwright-core');
    const {records,service,time}=fixture({}, {projects:{async getSnapshot(_actor,i){
      const files=snapshot('<main>Loading</main><script type="module" src="./app.mjs"></script>');
      files[1].content="export const twice=n=>n*2; if(typeof document!=='undefined'){let isolated=false;try{localStorage.length}catch{isolated=true}document.querySelector('main').textContent=twice(3)+' departures, isolated='+isolated}";
      return {...i,files};
    }}});
    t.after(()=>records.close());
    time.value=Date.now();
    const server=await startLocalDelivery({records});t.after(server.close);
    const built=await service.build('owner',input);
    assert.equal(built.status,'passed');
    const preview=await service.preview('owner',{projectId,buildId:built.buildId,requestId:'preview-browser'});
    const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true});
    t.after(()=>browser.close());
    const page=await browser.newPage();
    await page.goto(server.origin+new URL(preview.url).pathname);
    await page.getByText('6 departures, isolated=true').waitFor({timeout:6500});
  });
