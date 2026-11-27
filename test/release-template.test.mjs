import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { synthHosted } from '../infra/hosted.mjs';
import { stageHostedTemplate } from '../scripts/stage-hosted-template.mjs';

const readExample=async file=>JSON.parse(await readFile(new URL('../infra/'+file,import.meta.url),'utf8'));
async function assembly(t) {
  const dir=await mkdtemp(join(tmpdir(),'perottino-release-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const c=await readExample('example-hosted.json'),p=await readExample('example-provenance.json');
  const stack=synthHosted(c,p,dir);
  const content=JSON.stringify(stack.template)+'\n';
  await writeFile(stack.templateFullPath,content);
  const tags=p.tags;
  return {assembly:dir,account:c.account,region:c.region,scope:tags['factory:project-id']+'-'+tags['factory:environment'],
    source:tags['factory:last-source-commit'],content,registry:c.lambdaImage.split('@')[0]};
}
function provider(o) {
  const calls=[];
  const bootstrap='factory-'+o.scope+'-r-runtime';
  const bucket='synthetic-release-bucket';
  let stored, publicBlock=true, account=o.account, damaged=false;
  async function request(service,op,...args) {
    calls.push(op);
    const arg=x=>args[args.indexOf(x)+1];
    assert.equal(arg('--region'),o.region);
    if(service==='sts')return {Account:account};
    if(service==='cloudformation'){
      assert.equal(arg('--stack-name'),bootstrap);
      return {Stacks:[{StackName:bootstrap,StackId:'arn:aws:cloudformation:'+o.region+':'+o.account+':stack/'+bootstrap+'/fixture',StackStatus:'CREATE_COMPLETE',
        Tags:[{Key:'factory:s',Value:o.scope}],Outputs:[{OutputKey:'ReleaseTemplateBucketName',OutputValue:bucket},{OutputKey:'ImageRepositoryUri',OutputValue:o.registry}]}]};
    }
    assert.equal(service,'s3api');assert.equal(arg('--expected-bucket-owner'),o.account);assert.equal(arg('--bucket'),bucket);
    if(op==='get-bucket-tagging')return {TagSet:[{Key:'factory:s',Value:o.scope},{Key:'perottino:purpose',Value:'release-templates'}]};
    if(op==='get-bucket-location')return {LocationConstraint:o.region==='us-east-1'?null:o.region};
    if(op==='get-bucket-versioning')return {Status:'Enabled'};
    if(op==='get-public-access-block')return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:publicBlock,RestrictPublicBuckets:true}};
    if(op==='put-object') {
      assert.equal(arg('--if-none-match'),'*');assert.equal(arg('--server-side-encryption'),'AES256');
      if(stored)throw Object.assign(new Error('exists'),{code:'PreconditionFailed'});
      const contents=await readFile(arg('--body'));
      assert.equal(contents.toString('utf8'),o.content);
      assert.equal(arg('--checksum-sha256'),createHash('sha256').update(contents).digest('base64'));
      stored={VersionId:'v+2/=',ChecksumSHA256:arg('--checksum-sha256'),ContentLength:contents.length,ServerSideEncryption:'AES256'};
      return stored;
    }
    assert.equal(op,'head-object');assert.equal(arg('--checksum-mode'),'ENABLED');
    return damaged?{...stored,ChecksumSHA256:'wrong'}:stored;
  }
  return {request,calls,allowPublic:()=>{publicBlock=false;},wrongAccount:()=>{account='999999999999';},damageChecksum:()=>{damaged=true;}};
}
test('oversized CloudFormation template is pinned to verified bytes, target account and a reusable private S3 version',async t=>{
  const o=await assembly(t),s=provider(o);
  assert.ok(Buffer.byteLength(o.content)>51200);
  const receipt=await stageHostedTemplate(o,s.request);
  assert.ok(receipt.bytes>51200);
  assert.equal(receipt.sha256,createHash('sha256').update(o.content).digest('hex'));
  assert.equal(receipt.key,'releases/'+o.source+'/'+receipt.sha256+'/Hosted.template.json');
  assert.equal(new URL(receipt.templateUrl).searchParams.get('versionId'),'v+2/=');
  assert.equal(new URL(receipt.templateUrl).hostname,'s3.'+o.region+'.amazonaws.com');
  assert.deepEqual(await stageHostedTemplate(o,s.request),receipt);
  s.damageChecksum();await assert.rejects(stageHostedTemplate(o,s.request),/verify the expected immutable/);
});
test('mismatched scope or provider account and public-access settings stop before upload',async t=>{
  const o=await assembly(t);
  const wrong=provider(o);
  await assert.rejects(stageHostedTemplate({...o,source:'f'.repeat(40)},wrong.request),/provenance/);assert.deepEqual(wrong.calls,[]);
  wrong.wrongAccount();await assert.rejects(stageHostedTemplate(o,wrong.request),/caller account/);
  const pub=provider(o);pub.allowPublic();await assert.rejects(stageHostedTemplate(o,pub.request),/public-access/);
  assert.ok(!pub.calls.includes('put-object'));
});
