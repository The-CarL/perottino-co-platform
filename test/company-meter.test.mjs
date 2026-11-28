import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeModelMeter} from '../src/company-meter.mjs';
import {makeSqliteRecords} from '../src/foundation-records.mjs';
import {createGovernance} from '../src/company-governance.mjs';
test('admission rejects unfunded and stale policy, issues once and bills actual usage or maximum on uncertain outcome',async t=>{
  const records=makeSqliteRecords({filename:':memory:'});t.after(()=>records.close());
  const governance=createGovernance({records,store:{employee:async id=>({id,desiredState:'active'})}});
  const tariffs={model:{maxInputTokens:20000,maxOutputTokens:4000,inputCentsPerMillion:1000,outputCentsPerMillion:5000}};
  let version='v1';const settings={effective:async()=>({version,settings:{modelId:'model'}})};
  const meter=makeModelMeter({records,governance,settings,tariffs});
  const begin=requestId=>meter.execute('ceo','budget.model.begin',{requestId,modelId:'model',settingsVersion:version});
  const finish=(requestId,usage)=>meter.execute('ceo','budget.model.finish',{requestId,usage});
  const id=randomUUID();await assert.rejects(begin(id),{status:409});version='v2';await assert.rejects(begin(id),{status:409});
  await governance.execute('owner','policy.set',{totalBudgetCents:100,allowCeoPromotions:false,maxDirectReports:2,maxAllocationCents:50,requestId:randomUUID()});
  const paid=randomUUID();
  const permits=await Promise.all([begin(paid),begin(paid)]);assert.equal(permits.filter(v=>v.permitted).length,1);
  assert.equal((await finish(paid,{input_tokens:500,output_tokens:200})).chargedCents,2);
  assert.equal((await finish(paid)).chargedCents,2);
  const unknown=randomUUID();assert.equal((await begin(unknown)).permitted,true);assert.equal((await finish(unknown)).chargedCents,40);
  const {budget}=await governance.execute('ceo','governance.get');
  assert.equal(budget.reservedCents,0);assert.equal(budget.spentCents,42);assert.equal(budget.availableCents,58);
});
test('model reservation preserves host-assigned task attribution through replay and settlement',async t=>{
  const records=makeSqliteRecords({filename:':memory:'});t.after(()=>records.close());
  const calls=[];
  const governance={async execute(actor,op,input){calls.push({actor,op,input});return {reservation:{id:'r-test'}};}};
  const modelId='model',settingsVersion='config-1',taskId='t-'+'b'.repeat(32),requestId=randomUUID();
  const settings={effective:async()=>({version:settingsVersion,settings:{modelId}})};
  const meter=makeModelMeter({records,governance,settings,tariffs:{model:{maxInputTokens:100,maxOutputTokens:100,
    inputCentsPerMillion:100,outputCentsPerMillion:300}}});
  assert.equal((await meter.execute('ceo','budget.model.begin',{requestId,modelId,settingsVersion,taskId})).permitted,true);
  await assert.rejects(meter.execute('ceo','budget.model.begin',{requestId,modelId,settingsVersion,taskId:'different'}),{status:409});
  await meter.execute('ceo','budget.model.finish',{requestId,usage:{input_tokens:3,output_tokens:1}});
  assert.deepEqual(calls.map(c=>[c.op,c.input.taskId]),[['budget.reserve',taskId],['budget.settle',taskId]]);
});
