import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createGovernance } from '../src/company-governance.mjs';
import { createStore } from '../src/store.mjs';
import { createCloudStore } from '../src/cloud-store.mjs';
import { makeSqliteRecords,makeDynamoRecords } from '../src/foundation-records.mjs';

async function verify({records,store,hireNative,fireNative,bind}) {
  const service = createGovernance({records,store});
  const command = (actor,op,input={})=>service.execute(actor,op,input);
  const hire = (actor,input,hook) => service.hire(actor,input,async permit=>{
    await hook?.();
    return {employee:await hireNative(actor,input,permit)};
  });
  const limit = {maxDirectReports:4,maxAllocationCents:1000};
  const zero = await command('owner','governance.get');
  assert.equal(zero.budget.availableCents,0);
  assert.equal(zero.grant.active,true);
  await assert.rejects(command('ceo','policy.set',{requestId:'elevate'}),{status:403});
  await command('owner','policy.set',{requestId:'mandate',totalBudgetCents:2000,allowCeoPromotions:true,...limit});
  const request = {role:'Engineer',requestId:'new-eng',projectId:'weather',allocationCents:500};
  const {employee:eng} = await hire('ceo',request);
  await bind(eng.id);
  assert.equal((await hire('ceo',request)).employee.id,eng.id);
  await assert.rejects(hire('ceo',{...request,allocationCents:499}),{status:409});
  assert.equal((await command(eng.id,'governance.get')).budget.availableCents,500);
  const qa = {role:'QA',requestId:'hire-qa',projectId:'weather',allocationCents:75,taskId:'tested'};
  await assert.rejects(hire(eng.id,qa),{status:403});
  const proposal = {requestId:'qa-case',employeeId:eng.id,evidenceTaskIds:['tested'],firstHireCase:'Verify weekly weather deployments against the published acceptance criteria.',
    projectId:'weather',roles:['QA'],maxDirectReports:1,maxAllocationCents:100};
  await assert.rejects(command(eng.id,'promotion.propose',proposal),{status:409});
  await records.transact([{pk:'work:tasks',sk:'tested',expect:null,value:{id:'tested',assigneeId:eng.id,goalId:'weather-goal',status:'done',review:{decision:'accept'},evidence:['recorded test results']}}]);
  const proposed = await command(eng.id,'promotion.propose',proposal);
  await assert.rejects(command(eng.id,'promotion.approve',{requestId:'self',proposalId:proposed.proposal.id}),{status:403});
  await command('ceo','promotion.approve',{requestId:'within-policy',proposalId:proposed.proposal.id,taskId:'tested'});
  assert.equal(await service.canHire(eng.id),true);
  await assert.rejects(hire(eng.id,{...qa,projectId:'salaries'}),{status:403});
  await assert.rejects(hire(eng.id,{...qa,role:'CFO'}),{status:403});
  await assert.rejects(hire(eng.id,{...qa,allocationCents:101}),{status:409});
  assert.equal((await command(eng.id,'governance.get')).budget.availableCents,500);
  await assert.rejects(service.hire(eng.id,qa,async permit=>({employee:await hireNative(eng.id,{...qa,role:'CFO'},permit)})),{status:403});
  const attempts = await Promise.allSettled([hire(eng.id,qa),hire(eng.id,{...qa,requestId:'racing-qa'})]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  const child = attempts.find(r=>r.status==='fulfilled').value.employee;
  await bind(child.id);
  assert.equal(child.managerId,eng.id);
  assert.equal(await service.canHire(child.id),false);
  assert.equal((await command(eng.id,'governance.get')).budget.availableCents,425);
  const workProject='p-'+'b'.repeat(32);
  await records.transact([{pk:'work:tasks',sk:'qa-task',expect:null,value:{id:'qa-task',assigneeId:child.id,goalId:'weather-goal',status:'ready'}},
    {pk:'projects:goal:weather-goal',sk:workProject,expect:null,value:{id:workProject}}]);
  await assert.rejects(command(child.id,'budget.reserve',{requestId:'fake-task',amountCents:1,purpose:'model',taskId:'nonexistent'}),{status:404});
  const otherProject='p-'+'a'.repeat(32);
  await records.transact([{pk:'projects:catalog',sk:otherProject,expect:null,value:{goalIds:['unrelated-goal']}}]);
  await assert.rejects(command(child.id,'budget.reserve',{requestId:'wrong-project',amountCents:1,purpose:'model',taskId:'qa-task',projectId:otherProject}),{status:409});
  const funds = await Promise.allSettled(['preview','model'].map(purpose=>command(child.id,'budget.reserve',{requestId:purpose,amountCents:60,purpose,taskId:'qa-task'})));
  assert.equal(funds.filter(r=>r.status==='fulfilled').length,1);
  const held = funds.find(r=>r.status==='fulfilled').value.reservation;
  assert.equal((await command(child.id,'budget.reserve',{requestId:held.purpose,amountCents:60,purpose:held.purpose,taskId:'qa-task'})).replayed,true);
  await assert.rejects(command(eng.id,'budget.release',{requestId:'steal',reservationId:held.id}),{status:404});
  await command('owner','policy.set',{requestId:'new-policy',totalBudgetCents:2050,allowCeoPromotions:true,...limit});
  await assert.rejects(command(child.id,'budget.settle',{requestId:'relabel',reservationId:held.id,actualCents:2,taskId:'unrelated'}),{status:409});
  const settlement = {requestId:'settle',reservationId:held.id,actualCents:30};
  await command(child.id,'budget.settle',settlement);
  await command(child.id,'budget.settle',settlement);
  await assert.rejects(command(child.id,'budget.release',{requestId:'double',reservationId:held.id}),{status:409});
  assert.equal((await command(child.id,'governance.get')).budget.availableCents,45);
  assert.equal((await command(child.id,'governance.get')).budget.spentCents,30);
  await assert.rejects(command(eng.id,'budget.allocate',{requestId:'over',employeeId:child.id,amountCents:26}),{status:409});
  await command(eng.id,'budget.allocate',{requestId:'topup',employeeId:child.id,amountCents:25});
  const target = {requestId:'terminate',agentId:child.id};
  await service.fire(eng.id,target,async permit=>({employee:await fireNative(eng.id,target,permit)}));
  assert.equal((await command('owner','budget.reclaim',{requestId:'recover-unused',employeeId:child.id,amountCents:70})).budget.availableCents,0);
  let revoked = false;
  await assert.rejects(hire(eng.id,{...qa,requestId:'revocation-race',allocationCents:0},async()=>{
    if (!revoked) { revoked=true; await command('owner','grant.revoke',{requestId:'revoke',employeeId:eng.id}); }
  }),{status:403});
  assert.equal((await store.employee(eng.id)).desiredState,'active');
  assert.equal(await service.canHire(eng.id),false);
  assert.equal((await store.listEmployees()).length,3);
  await assert.rejects(Promise.resolve().then(()=>hireNative('ceo',{role:'Unmetered',requestId:'raw'},undefined)));
  await assert.rejects(Promise.resolve().then(()=>hireNative(eng.id,{role:'QA',requestId:'fake'},{})));
  assert.equal((await store.listEmployees()).length,3);
  await assert.rejects(command('owner','policy.set',{requestId:'withdraw',totalBudgetCents:0,maxAllocationCents:0,maxDirectReports:1,allowCeoPromotions:false}),{status:409});
  await command('owner','grant.revoke',{requestId:'stop-ceo',employeeId:'ceo'});
  await assert.rejects(hire('ceo',{...request,requestId:'while-revoked'}),{status:403});
  await command('owner','grant.restore',{requestId:'restore-ceo',employeeId:'ceo'});
  assert.equal(await service.canHire('ceo'),true);
  const auditable = (await records.list('company-events',{limit:100})).items;
  const approval = auditable.find(e=>e.kind==='promotion.approve'), grantedHire=auditable.find(e=>e.kind==='employee.hire' && e.actor===eng.id);
  const settled = auditable.filter(e=>e.kind==='budget.settle' && e.employeeId===child.id);
  assert.equal(settled.length,1);
  for (const event of [approval,grantedHire]) {
    assert.equal(event.grantId,proposed.proposal.id); assert.equal(event.projectId,'weather');
    assert.equal(event.policyVersion,1); assert.equal(event.taskId,'tested');
  }
  assert.equal(approval.amountKind,'allocation-ceiling');assert.equal(approval.amountCents,100);
  assert.equal(grantedHire.amountCents,75);assert.equal(grantedHire.managerId,eng.id);
  const [charge]=settled;
  assert.equal(charge.policyVersion,1);assert.equal(charge.reservationId,held.id);
  assert.equal(charge.amountCents,30);assert.equal(charge.amountKind,'policy-ledger-charge');
  assert.equal(charge.fundingGrantId,proposed.proposal.id);assert.equal(charge.taskId,'qa-task');
  assert.equal(charge.resourceId,'budget:'+child.id);assert.equal(charge.purpose,held.purpose);assert.equal(charge.projectId,workProject);
  assert.equal((await command('owner','policy.get')).policy.revision,2);
  assert.doesNotMatch(JSON.stringify(auditable),/Verify weekly weather deployments|recorded test results/);
  assert.match((await command('owner','governance.get')).accounting.basis,/AWS invoices/);
}

test('SQLite directory and governance commit promotion, hiring, revocation and spending atomically',async()=>{
  const dir = mkdtempSync(join(tmpdir(),'governance-')), store = createStore(dir);
  const records = makeSqliteRecords({filename:join(dir,'company.sqlite')});
  try {
    await verify({store,records,bind:async()=>{},
      hireNative:(actor,input,permit)=>store.hireCompanyEmployee(actor,1,input,permit),
      fireNative:(actor,input,permit)=>store.setEmployeeState({agentId:input.agentId,operation:'fire',requestId:input.requestId,
        callerId:actor,generation:1,governancePermit:permit}).employee});
  } finally { records.close(); store.close(); rmSync(dir,{recursive:true,force:true}); }
});

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;
if (endpoint && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/.test(endpoint)) throw Error('Local DynamoDB endpoint required.');
test('DynamoDB directory, binding, grant and wallet commit in the same transaction',{skip:!endpoint},async()=>{
  const raw = new DynamoDBClient({endpoint,region:'us-east-1',credentials:{accessKeyId:'test',secretAccessKey:'test'}});
  const client = DynamoDBDocumentClient.from(raw), tableName = 'governance-'+randomUUID();
  await raw.send(new CreateTableCommand({TableName:tableName,BillingMode:'PAY_PER_REQUEST',
    AttributeDefinitions:['pk','sk'].map(AttributeName=>({AttributeName,AttributeType:'S'})),
    KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]}));
  const store = createCloudStore({tableName,client}), records = makeDynamoRecords({tableName,client});
  const binding = id=>({agentId:id,generation:1,taskArn:'arn:test:'+id});
  const bind = async id=>assert.equal(await store.bindEmployeeTask(binding(id)),true);
  try {
    await store.ensureCEO(); await bind('ceo');
    await verify({records,store,bind,hireNative:(actor,input,governancePermit)=>store.hireEmployee({
      callerId:actor,binding:binding(actor),companyGate:false,governancePermit,role:input.role,requestId:input.requestId,
      name:'Employee '+input.requestId,handle:'staff-'+input.requestId,generatedIdentity:true}),
      fireNative:(actor,input,governancePermit)=>store.setEmployeeState({callerId:actor,binding:binding(actor),companyGate:false,
        governancePermit,desiredState:'fired',requestId:input.requestId,agentId:input.agentId})});
  } finally { await raw.send(new DeleteTableCommand({TableName:tableName})); raw.destroy(); }
});
