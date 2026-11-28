import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {CreateBucketCommand,GetObjectCommand,ListObjectVersionsCommand,PutBucketVersioningCommand,S3Client} from '@aws-sdk/client-s3';
import {createStore} from '../src/store.mjs';
import {makeSqliteRecords} from '../src/foundation-records.mjs';
import {createCompanyService} from '../src/company-service.mjs';
import {localBlobs,s3Blobs} from '../src/company-files.mjs';

async function fixture(t,cloud) {
  const dir=await mkdtemp(join(tmpdir(),'perottino-shared-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let blobs,client,bucket;
  if(cloud) {
    const url=new URL(process.env.S3_TEST_ENDPOINT);
    assert.equal(url.hostname,'127.0.0.1');
    client=new S3Client({region:'us-east-1',endpoint:url.href,forcePathStyle:true,
      credentials:{accessKeyId:'emulator',secretAccessKey:'emulator'}});
    bucket='corporate-'+randomUUID();
    await client.send(new CreateBucketCommand({Bucket:bucket}));
    await client.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
    blobs=s3Blobs(bucket,client);t.after(()=>client.destroy());
  } else blobs=localBlobs(join(dir,'bytes'));
  let store,records,service;
  function open() {
    store=createStore(dir);
    records=makeSqliteRecords({filename:join(dir,'company.sqlite')});
    service=createCompanyService({store,records,adapters:{blobs,modelIds:['first','second']},
      control(actor,op,input,permit){assert.equal(op,'employee.hire');return {employee:store.hireCompanyEmployee(actor,store.employee(actor).generation,input,permit)};}});
  }
  function close(){records.close();store.close();}
  open();t.after(close);
  return {cmd:(actor,op,input)=>service.execute(actor,op,input),restart(){close();open();},client,bucket};
}
for(const cloud of [false,true]) test('shared workspace and SOUL survive a new company process on '+(cloud?'the S3 protocol':'local disk'),
  {skip:cloud&&!process.env.S3_TEST_ENDPOINT},async t=>{
    const f=await fixture(t,cloud),cmd=f.cmd;
    const {employee}=await cmd('ceo','employee.hire',{role:'Engineer',requestId:'create-engineer'});
    const a=employee.id, path='projects/demo/decision.txt';
    const soul=await cmd(a,'soul.get',{});
    assert.equal(soul.file.path,'agents/'+employee.handle+'/SOUL.md');
    const first={path,text:'First decision',expectedVersion:0,requestId:'first'};
    assert.equal((await cmd('ceo','files.write',first)).file.version,1);
    const write={path,text:'Corrected decision',expectedVersion:1,requestId:'second'};
    const result=await cmd(a,'files.write',write);
    assert.equal(result.file.authorId,a);
    assert.deepEqual(await cmd(a,'files.write',write),result);
    await assert.rejects(cmd(a,'files.write',{...write,text:'Changed'}),{status:409});
    await assert.rejects(cmd(a,'files.write',{...write,requestId:'stale'}),{status:409});
    await assert.rejects(cmd(a,'files.read',{path:'../settings'}),{status:400});
    const one=await cmd(a,'files.part',{contentBase64:'/wA='}),two=await cmd(a,'files.part',{contentBase64:'AQI='});
    await cmd(a,'files.commit',{path:'groups/design/image.bin',requestId:'image',parts:[one.sha256,two.sha256]});
    f.restart();
    assert.equal((await cmd('ceo','files.read',{path})).file.text,'Corrected decision');
    assert.equal((await cmd('ceo','files.read',{path,version:1})).file.text,'First decision');
    assert.equal((await cmd('ceo','files.list',{prefix:'projects/demo/'})).files.length,1);
    assert.equal((await cmd('ceo','files.read',{path:'groups/design/image.bin',part:1})).file.contentBase64,'AQI=');
    if(cloud) {
      const versions=await f.client.send(new ListObjectVersionsCommand({Bucket:f.bucket,Prefix:'company/'+path}));
      assert.equal(versions.Versions.length,2);
      const object=await f.client.send(new GetObjectCommand({Bucket:f.bucket,Key:'company/'+path}));
      assert.equal(await object.Body.transformToString(),'Corrected decision');
    }
  });
test('owner restores settings and corrects durable personal knowledge across a restart',async t=>{
  const f=await fixture(t,false),cmd=f.cmd;
  const {employee:{id}}=await cmd('ceo','employee.hire',{role:'QA',requestId:'qa'});
  const company={scope:'company',settings:{modelId:'second',mandate:'Test a public dataset'},requestId:'mandate'};
  await cmd('owner','settings.update',company);
  await assert.rejects(cmd(id,'settings.update',company),{status:403});
  await cmd('owner','settings.update',{scope:'role',target:'QA',settings:{pulseSeconds:12},requestId:'qa-defaults'});
  await cmd('owner','settings.update',{scope:'employee',target:id,settings:{pulseSeconds:9},requestId:'employee'});
  const before=await cmd(id,'settings.effective',{});
  assert.equal(before.settings.modelId,'second');assert.equal(before.settings.pulseSeconds,9);
  assert.equal(before.origins.pulseSeconds,'employee#'+id);
  await cmd('owner','settings.update',{scope:'employee',target:id,settings:{pulseSeconds:null},requestId:'inherit'});
  assert.equal((await cmd(id,'settings.effective',{})).settings.pulseSeconds,12);
  const path='projects/forecast/source.md';
  await cmd(id,'files.write',{path,text:'Inputs updated each Monday',requestId:'source'});
  const {memoryId}=await cmd(id,'knowledge.save',{text:'Update weekly',source:{path,version:1},pinned:true,requestId:'note'});
  await assert.rejects(cmd('ceo','knowledge.list',{employeeId:id}),{status:403});
  await cmd('owner','knowledge.correct',{employeeId:id,memoryId,text:'Check Monday',requestId:'correct'});
  f.restart();
  const [m]=(await cmd(id,'knowledge.list',{query:'Monday'})).memories;
  assert.equal(m.text,'Check Monday');assert.deepEqual(m.source,{path,version:1});
  await cmd('owner','settings.restore',{scope:'employee',target:id,revision:1,expectedVersion:2,requestId:'restore'});
  assert.equal((await cmd(id,'settings.effective',{})).settings.pulseSeconds,9);
  await cmd(id,'knowledge.forget',{memoryId,requestId:'forget'});
  assert.deepEqual((await cmd(id,'knowledge.list',{})).memories,[]);
});
