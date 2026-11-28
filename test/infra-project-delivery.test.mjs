import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthHosted } from '../infra/hosted.mjs';
const example=name=>JSON.parse(readFileSync(new URL('../infra/'+name,import.meta.url),'utf8'));

test('hosted static delivery has its own public reader origin and a private executor with no company data or secrets',t=>{
  const out=mkdtempSync(join(tmpdir(),'delivery-iac-'));t.after(()=>rmSync(out,{recursive:true,force:true}));
  const template=synthHosted(example('example-hosted.json'),example('example-provenance.json'),out).template;
  const r=template.Resources;
  assert.equal(r.DeliveryExecutor.Properties.ImageConfig.Command[0],'src/delivery-executor.handler');
  assert.equal(r.DeliveryExecutor.Properties.Timeout,6);
  assert.deepEqual(r.DeliveryExecutorRole.Properties.Policies[0].PolicyDocument.Statement.map(s=>s.Action),
    [['logs:CreateLogStream','logs:PutLogEvents']]);
  assert.deepEqual(r.DeliveryExecutor.Properties.Role,{'Fn::GetAtt':['DeliveryExecutorRole','Arn']});
  const publicPermissions=Object.values(r).filter(x=>x.Type==='AWS::Lambda::Permission' &&
    JSON.stringify(x.Properties.FunctionName).includes('Delivery'));
  assert.equal(publicPermissions.length,1);
  assert.ok(JSON.stringify(publicPermissions[0].Properties.FunctionName).includes('DeliveryReader'));
  assert.ok(JSON.stringify(publicPermissions[0].Properties.SourceArn).includes('DeliveryApi'));
  const readerData=r.DeliveryReaderRole.Properties.Policies[0].PolicyDocument.Statement.find(x=>x.Action==='dynamodb:GetItem');
  assert.deepEqual(readerData.Resource,{'Fn::GetAtt':['State','Arn']});
  assert.deepEqual(readerData.Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'],
    ['V2#PUBLICSITE#PREVIEW','V2#PUBLICSITE#PRODUCTION']);
  assert.equal(r.DeliveryApi.Properties.ProtocolType,'HTTP');
  const routes=Object.values(r).filter(x=>x.Type==='AWS::ApiGatewayV2::Route' && x.Properties.ApiId.Ref==='DeliveryApi');
  assert.deepEqual(routes.map(x=>x.Properties.RouteKey).sort(),['GET /{proxy+}','HEAD /{proxy+}']);
  assert.equal(r.DeliveryStage.Properties.DefaultRouteSettings.ThrottlingBurstLimit,20);
  assert.ok(r.FactoryRole.Properties.Policies[0].PolicyDocument.Statement.some(x=>x.Action==='lambda:InvokeFunction' &&
    JSON.stringify(x.Resource).includes('DeliveryExecutor')));
  assert.ok(!JSON.stringify(r.WorkerRole.Properties.Policies).includes('DeliveryExecutor'));
  assert.deepEqual(r.DeliveryReaderRole.Properties.PermissionsBoundary,r.WorkerRole.Properties.PermissionsBoundary);
});
