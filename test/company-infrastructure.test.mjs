import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {makeSqliteRecords} from '../src/foundation-records.mjs';
import {createInfrastructure,createLocalInfrastructure,createRemoteInfrastructure,reconcileInfrastructure,queueTemplate} from '../src/company-infrastructure.mjs';
import {createQueueProvisioner} from '../src/sandbox-provisioner.mjs';

const projectId='p-'+'1'.repeat(32),account='111111111111',region='us-east-1',scope='11111111-1111-1111-1111-111111111111-dev';
const input={projectId,template:queueTemplate,requestId:'first',ttlHours:1};
const projects={async execute(actor,op,i) {
  if(op!=='project.get'||i.projectId!==projectId || !['ceo','owner'].includes(actor)) throw Object.assign(new Error('Project denied.'),{status:403});
  return {project:{id:projectId}};
}};
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'sandbox-queues-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const records=makeSqliteRecords({filename:':memory:'});t.after(()=>records.close());
  const time={value:Date.UTC(2026,0,1)},now=()=>time.value;
  const provider=createLocalInfrastructure({directory,now});
  const infra=createInfrastructure({records,projects,provider,now});
  return {infra,provider,records,time,now,directory};
}

test('local template creates a usable durable private queue, reacquires it on restart and cleans expired data',async t=>{
  const f=fixture(t);
  const queued=await f.infra.provision('ceo',input);
  assert.equal(queued.status,'active');
  const physical=new DatabaseSync(join(f.directory,'queue-0.sqlite'));t.after(()=>physical.close());
  physical.prepare('INSERT INTO messages(body) VALUES (?)').run('example data');
  const restarted=createInfrastructure({records:f.records,projects,provider:createLocalInfrastructure({directory:f.directory,now:f.now}),now:f.now});
  assert.deepEqual(await restarted.provision('ceo',input),queued);
  assert.equal(physical.prepare('SELECT body FROM messages').get().body,'example data');
  assert.equal((await restarted.list('owner',{projectId})).resources[0].resourceId,queued.resourceId);
  await assert.rejects(()=>restarted.provision('ceo',{...input,ttlHours:2}),{status:409});
  await assert.rejects(()=>restarted.provision('other',input),{status:403});
  await assert.rejects(()=>restarted.remove('ceo',{...input,resourceId:queued.resourceId}),{status:403});
  f.time.value+=3600000;
  await reconcileInfrastructure(f.records,f.provider,f.now);
  assert.equal((await restarted.status('owner',{projectId,resourceId:queued.resourceId})).status,'removed');
  assert.equal(physical.prepare('SELECT count(*) AS n FROM messages').get().n,0);
  assert.equal((await restarted.provision('ceo',input)).status,'removed');
});

test('fixed slots cap concurrent provisioning and expired or removed requests cannot delete a newer project binding',async t=>{
  const {infra,provider}=fixture(t);
  const values=await Promise.all(Array.from({length:8},(_,i)=>infra.provision('ceo',{...input,requestId:'q'+i})));
  assert.equal(new Set(values.map(r=>r.url)).size,8);
  await assert.rejects(()=>infra.provision('ceo',{...input,requestId:'overflow'}),{status:429});
  await assert.rejects(()=>infra.provision('ceo',{...input,template:'arbitrary'}),{status:400});
  const first=values[0],remove={requestId:'retire',projectId,resourceId:first.resourceId};
  assert.equal((await infra.remove('owner',remove)).status,'removed');
  const latest=await infra.provision('ceo',{...input,requestId:'replacement'});
  const stale=await provider.execute('remove',{...first,slot:0});
  assert.deepEqual(stale,{status:'absent'});
  assert.equal((await infra.status('owner',{projectId,resourceId:latest.resourceId})).status,'active');
  assert.equal((await infra.remove('owner',remove)).status,'removed');
});

function fakeSqs(){
  const queues=new Map(),calls=[];
  const url=name=>'https://sqs.'+region+'.amazonaws.com/'+account+'/'+name;
  const missing=()=>Object.assign(new Error(),{name:'QueueDoesNotExist'});
  return {queues,calls,async send(cmd){
    const action=cmd.constructor.name,v=cmd.input;calls.push([action,v]);
    if(action==='CreateQueueCommand'){queues.set(url(v.QueueName),v.tags);return {QueueUrl:url(v.QueueName)};}
    if(action==='DeleteQueueCommand'){queues.delete(v.QueueUrl);return {};}
    if(action==='GetQueueUrlCommand'){
      assert.equal(v.QueueOwnerAWSAccountId,account);
      if(!queues.has(url(v.QueueName))) throw missing();
      return {QueueUrl:url(v.QueueName)};
    }
    if(action==='GetQueueAttributesCommand') return {Attributes:{SqsManagedSseEnabled:'true',MessageRetentionPeriod:'3600',MaximumMessageSize:'65536',VisibilityTimeout:'30'}};
    if(action==='ListQueueTagsCommand'){if(!queues.has(v.QueueUrl)) throw missing();return {Tags:queues.get(v.QueueUrl)};}
    throw new Error('Unexpected AWS operation '+action);
  }};
}

test('sandbox SQS adapter verifies target identity before changes, fails closed on foreign tags and sweeps only expired owned queues',async()=>{
  const sqs=fakeSqs(),time={v:Date.UTC(2026,0,1)},now=()=>time.v;
  const provider=createQueueProvisioner({sqs,scope,region,account,now,provenance:{'factory:owner':'operator'}});
  const spec={projectId,resourceId:'i-'+'a'.repeat(32),slot:3,template:queueTemplate,
    createdAt:new Date(now()).toISOString(),expiresAt:new Date(now()+3600000).toISOString()};
  const created=await provider.execute('provision',spec);assert.equal(created.status,'active');
  assert.deepEqual(await provider.execute('provision',spec),created);
  const creates=sqs.calls.filter(([x])=>x==='CreateQueueCommand');assert.equal(creates.length,1);
  assert.equal(creates[0][1].Attributes.SqsManagedSseEnabled,'true');assert.equal(creates[0][1].Attributes.MessageRetentionPeriod,'3600');
  assert.equal(creates[0][1].tags['factory:owner'],'operator');
  const foreign={...spec,slot:4,resourceId:'i-'+'f'.repeat(32)};
  const otherUrl=created.url.replace(/3$/,'4');
  sqs.queues.set(otherUrl,{...sqs.queues.get(created.url),'factory:s':'another-project'});
  await assert.rejects(()=>provider.execute('provision',foreign),{status:409});
  assert.equal((await provider.execute('remove',foreign)).status,'absent');
  time.v+=3600000;assert.deepEqual(await provider.sweep(),{expired:1});
  assert.deepEqual([...sqs.queues.keys()],[otherUrl]);
  await assert.rejects(()=>provider.execute('provision',spec),{status:409});
});

test('assessment attribution on new queues uses the configured scope and cannot be overridden by request or provenance',async()=>{
  const stamp=Date.UTC(2026,0,1), now=()=>stamp;
  const spec={projectId,resourceId:'i-'+'a'.repeat(32),slot:0,template:queueTemplate,
    createdAt:new Date(stamp).toISOString(),expiresAt:new Date(stamp+3600000).toISOString(),assessmentScope:'untrusted'};
  const sqs=fakeSqs();
  const config={sqs,scope,region,account,now,provenance:{'perottino:assessment':'untrusted'}};
  const regular=createQueueProvisioner(config), tagged=createQueueProvisioner({...config,assessmentScope:scope});
  await regular.execute('provision',spec);
  await tagged.execute('provision',spec); // Reconciliation leaves an older live generation intact.
  await tagged.execute('provision',{...spec,slot:1,resourceId:'i-'+'b'.repeat(32)});
  const creates=sqs.calls.filter(([op])=>op==='CreateQueueCommand').map(([,input])=>input.tags);
  assert.equal(creates.length,2);
  assert.equal(creates[0]['perottino:assessment'],undefined);
  assert.equal(creates[1]['perottino:assessment'],scope);
  assert.equal(creates[1]['factory:s'],scope);
  assert.equal(creates[1]['perottino:purpose'],queueTemplate);
  assert.throws(()=>createQueueProvisioner({...config,assessmentScope:'another-company'}),{status:500});
  const yaml=readFileSync(new URL('../infra/sandbox-queues.yaml',import.meta.url),'utf8');
  assert.match(yaml,/aws:RequestTag\/perottino:assessment:\s+Fn::If: \[AssessmentTagged, \{Ref: ProjectScope/);
});

test('cross-account broker signs only the configured regional sandbox endpoint and refuses redirects',async()=>{
  const origin='https://abcdefghij.execute-api.us-east-1.amazonaws.com', resourceId='i-'+'a'.repeat(32);
  const provider=createRemoteInfrastructure({origin,region,credentials:{accessKeyId:'TEST',secretAccessKey:'test-secret'},transport:async(url,init)=>{
    assert.equal(url,origin+'/sandbox/resources');assert.equal(init.redirect,'error');assert.equal(init.method,'POST');
    assert.match(init.headers.authorization,/Credential=TEST\/.+\/us-east-1\/execute-api\/aws4_request/);
    assert.ok(!init.body.includes('test-secret'));
    assert.equal(JSON.parse(init.body).spec.resourceId,resourceId);
    return Response.json({status:'absent'});
  }});
  const createdAt=new Date().toISOString(),expiresAt=new Date(Date.parse(createdAt)+3600000).toISOString();
  assert.equal((await provider.execute('status',{template:queueTemplate,slot:2,resourceId,projectId,createdAt,expiresAt})).status,'absent');
  assert.throws(()=>createRemoteInfrastructure({origin:'https://example.test',region}));
  const yaml=readFileSync(new URL('../infra/sandbox-queues.yaml',import.meta.url),'utf8');
  assert.match(yaml,/AuthorizationType: AWS_IAM/);assert.match(yaml,/aws:PrincipalArn/);assert.doesNotMatch(yaml,/sqs:(?:ListQueues|PurgeQueue|SetQueueAttributes|AddPermission)/);
});
