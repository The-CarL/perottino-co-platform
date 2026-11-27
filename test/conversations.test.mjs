import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversations } from '../src/conversations.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';

function fixture(t) {
  const records = makeSqliteRecords({ filename: ':memory:' });
  t.after(() => records.close());
  let clock = 1_800_000_000_000;
  const members = new Map(['ceo', 'ada', 'ben', 'lee', ...Array.from({ length: 100 }, (_, i) => 'seat-' + i)]
    .map(id => [id, { id, desiredState: 'active' }]));
  const transactions = [];
  const traced = { ...records, transact: async rows => {
    const result = await records.transact(rows);
    if (result) transactions.push(rows);
    return result;
  } };
  const company = createConversations({ records: traced, employee: async id => members.get(id), now: () => clock });
  return { run: company.execute, records, members, transactions, advance: ms => { clock += ms; } };
}

const fail = (promise, status) => assert.rejects(promise, error => error.status === status);
const dm = async (run, actor, peerId) => (await run(actor, 'conversations.dm', { peerId })).conversation;
const send = async (run, actor, conversationId, text, requestId, extra) =>
  (await run(actor, 'messages.post', { conversationId, text, requestId, ...extra })).message;
const read = async (run, actor, conversationId, extra) => (await run(actor, 'messages.list', { conversationId, ...extra })).messages;

test('DM identity is symmetric and group visibility is restricted, including founder administrative reads', async t => {
  const { run, transactions } = fixture(t);
  const [first, second] = await Promise.all([dm(run, 'ada', 'ben'), dm(run, 'ben', 'ada')]);
  assert.equal(first.id, second.id);
  const message = await send(run, 'ada', first.id, 'Private review memo.', 'note');
  assert.deepEqual((await run('owner', 'conversations.list')).conversations, []);
  await fail(read(run, 'owner', first.id), 404);
  await fail(read(run, 'lee', first.id), 404);
  assert.deepEqual((await run('ben', 'conversations.get', {conversationId:first.id})).conversation, first);
  assert.deepEqual((await run('ada', 'messages.get', {conversationId:first.id,messageId:message.id})).message, message);
  await fail(run('owner', 'messages.get', {conversationId:first.id,messageId:message.id}),404);
  await fail(run('ceo', 'admin.messages', { conversationId: first.id }), 403);
  const before = transactions.length;
  assert.equal((await run('owner', 'admin.conversations')).conversations[0].id, first.id);
  assert.deepEqual((await run('owner', 'admin.messages', {conversationId:first.id})).messages, [message]);
  assert.equal(transactions.length, before + 2);
  assert.doesNotMatch(JSON.stringify(transactions.slice(-2)), /Private review memo/);
  await fail(send(run, 'ada', first.id, 'impersonation', 'imp', { senderId: 'owner' }), 400);
  await fail(run('ada', 'conversations.dm', {peerId:'missing'}), 404);
});

test('idempotent group sends preserve one sequence and order under concurrent writers and retries', async t => {
  const { run } = fixture(t);
  const group = { members:['ada','ben'], title:'Release', requestId:'create' };
  const { conversation } = await run('ceo', 'conversations.group', group);
  assert.deepEqual((await run('ceo', 'conversations.group', {...group,members:['ben','ada']})).conversation,conversation);
  await fail(run('ceo','conversations.group',{...group,title:'Other'}),409);
  const id = conversation.id;
  const duplicate = await Promise.all(Array.from({length:8},()=>send(run,'ada',id,'Reviewed','same')));
  assert.equal(new Set(duplicate.map(row=>row.id)).size,1);
  assert.deepEqual(duplicate[0].responders,[]);
  await fail(send(run,'ada',id,'Changed','same'),409);
  await Promise.all(Array.from({length:13},(_,i)=>send(run,'ben',id,'Checkpoint '+i,'step-'+i)));
  const rows=await read(run,'ada',id);
  assert.deepEqual(rows.map(row=>row.seq),Array.from({length:14},(_,i)=>i+1));
  const latest=await run('ada','messages.list',{conversationId:id,latest:true,limit:4});
  assert.deepEqual(latest.messages.map(r=>r.seq),[11,12,13,14]);
  const older=await run('ada','messages.list',{conversationId:id,beforeSeq:latest.previousBeforeSeq,limit:4});
  assert.deepEqual(older.messages.map(r=>r.seq),[7,8,9,10]);
  const page=await run('ada','messages.list',{conversationId:id,limit:2});
  assert.equal((await read(run,'ada',id,{after:page.next,limit:1}))[0].seq,3);
  const only=await dm(run,'ada','ben');
  await fail(send(run,'ada',only.id,'Wrong thread','bad',{replyTo:rows[0].id}),404);
});

test('delivery resumes its staged work, fences expired workers, and atomically replies without waking another agent', async t => {
  const { run, advance } = fixture(t);
  const secret=await dm(run,'owner','ceo');
  await send(run,'owner',secret.id,'Founder private note','private',{responders:[]});
  const {conversation}=await run('ceo','conversations.group',{title:'Quarterly review',members:['ada','ben'],requestId:'g'});
  const id=conversation.id;
  await send(run,'ben',id,'Starting group review','intro');
  const msg=await send(run,'ada',id,'Please check totals','check',{responders:['ceo'],traceparent:'forged-by-client'});
  const claimer=id=>run(id,'deliveries.claim',{workerId:'task-for-'+id,leaseMs:10});
  const initial=await claimer('ceo');
  assert.equal(initial.message.id,msg.id);
  assert.notEqual(initial.delivery.traceparent,'forged-by-client');
  assert.deepEqual(initial.history.map(row=>row.text),['Starting group review']);
  assert.equal((await claimer('ceo')).delivery,null);
  assert.equal((await claimer('ben')).delivery,null);
  const scope={conversationId:id,messageId:msg.id};
  const first={...scope,token:initial.delivery.token};
  assert.deepEqual(await run('ceo','deliveries.stage',{...first,plan:{receipt:'stable'}}),{plan:{receipt:'stable'}});
  assert.deepEqual(await run('ceo','deliveries.stage',{...first,plan:{receipt:'new'}}),{plan:{receipt:'stable'}});
  advance(11);
  const recovered=await claimer('ceo');
  assert.notEqual(recovered.delivery.token,initial.delivery.token);
  assert.deepEqual(recovered.delivery.plan,{receipt:'stable'});
  await fail(run('ceo','deliveries.ack',{...first,reply:'Discard stale completion'}),409);
  await fail(run('ben','deliveries.ack',first),404);
  const done={...scope,token:recovered.delivery.token,reply:'The totals match.'};
  const acks=await Promise.all([run('ceo','deliveries.ack',done),run('ceo','deliveries.ack',done)]);
  assert.deepEqual(acks[0],acks[1]);
  assert.equal(acks[0].message.replyTo,msg.id);
  assert.equal(acks[0].message.senderId,'ceo');
  assert.deepEqual(acks[0].message.responders,[]);
  assert.equal((await read(run,'ada',id)).length,3);
  assert.equal((await claimer('ada')).delivery,null);
  assert.deepEqual((await run('ada','messages.status',scope)).deliveries,[{recipientId:'ceo',attempts:2,status:'done'}]);
});

test('group fanout reaches a full company through one atomic post, with independent recipient claims', async t => {
  const { run, transactions } = fixture(t);
  const seats=Array.from({length:100},(_,i)=>'seat-'+i);
  const {conversation}=await run('owner','conversations.group',{title:'Company',members:seats,requestId:'all'});
  const msg=await send(run,'owner',conversation.id,'Check your assignments.','broadcast',{responders:seats});
  assert.ok(transactions.at(-1).length < 100);
  assert.equal(transactions.at(-1).filter(row=>row.value?.text===msg.text).length,1);
  const employees=seats.slice(0,16);
  const received=await Promise.all(employees.map(id=>run(id,'deliveries.claim',{workerId:'task'})));
  assert.ok(received.every(entry=>entry.message.id===msg.id));
  await Promise.all(employees.map((id,i)=>run(id,'deliveries.ack',{conversationId:conversation.id,messageId:msg.id,token:received[i].delivery.token})));
  const statuses=await run('owner','messages.status',{conversationId:conversation.id,messageId:msg.id});
  assert.equal(statuses.deliveries.filter(row=>row.status==='done').length,16);
  assert.equal(statuses.deliveries.filter(row=>row.status==='queued').length,84);
});

test('failed delivery unblocks following messages and never fabricates a response', async t => {
  const { run, members }=fixture(t);
  const {id}=await dm(run,'owner','ceo');
  const first=await send(run,'owner',id,'first','1');
  const next=await send(run,'owner',id,'next','2');
  for (let attempts=1;attempts<=3;attempts++) {
    const {delivery}=await run('ceo','deliveries.claim',{workerId:'task'});
    assert.equal(delivery.messageId,first.id);assert.equal(delivery.attempts,attempts);
    await run('ceo','deliveries.release',{...delivery});
  }
  const {deliveries}=await run('owner','messages.status',{conversationId:id,messageId:first.id});
  assert.deepEqual(deliveries,[{recipientId:'ceo',attempts:3,status:'failed'}]);
  assert.equal((await run('ceo','deliveries.claim',{workerId:'fresh'})).message.id,next.id);
  assert.equal((await read(run,'owner',id)).length,2);
  members.get('ceo').desiredState='paused';
  await fail(run('ceo','messages.list',{conversationId:id}),403);
});
