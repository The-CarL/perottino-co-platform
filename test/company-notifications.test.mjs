import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { createConversations } from '../src/conversations.mjs';
import { deliverNextGoalNotice, notificationRow } from '../src/company-notifications.mjs';

async function setup(t) {
  const records = makeSqliteRecords({ filename: ':memory:' });
  t.after(() => records.close());
  const people = new Map([['lead', { id: 'lead', desiredState: 'active' }], ['engineer', { id: 'engineer', desiredState: 'active' }]]);
  const conversations = createConversations({ records, employee: id => people.get(id) });
  const { conversation } = await conversations.execute('owner', 'conversations.dm', { peerId: 'lead' });
  const conversationId = conversation.id;
  const { message } = await conversations.execute('owner', 'messages.post', { conversationId,
    text: 'Owner private request', responders: [], requestId: 'start' });
  const source = { conversationId, messageId: message.id };
  const goal = { id: 'a'.repeat(64), accountableId: 'lead', status: 'done', source,
    outcome: 'private customer name', evidence: ['private contract'], closedBy: 'owner' };
  const row = notificationRow(goal);
  await records.transact([row]);
  const messages = async () => (await conversations.execute('owner', 'messages.list', { conversationId })).messages;
  const deliver = (args = {}) => deliverNextGoalNotice({ actor: 'lead', records, conversations, ...args });
  return { records, conversations, people, goal, row, source, deliver, messages };
}

test('a lost acknowledgement and simultaneous retries publish one private-context-safe threaded notice', async t => {
  const { records, conversations, goal, row, source, deliver, messages } = await setup(t);
  assert.equal(notificationRow({ ...goal, source: undefined }), null);
  assert.equal(notificationRow({ ...goal, status: 'active' }), null);
  assert.deepEqual(row.value, source);
  assert.equal(await deliver({ actor: 'engineer' }), false);
  const interrupted = { ...records, transact: async () => { throw new Error('Simulated failure before acknowledgement'); } };
  await assert.rejects(deliver({ records: interrupted }), /Simulated/);
  assert.ok(await records.get(row.pk, row.sk));

  await Promise.all([deliver(), deliver()]);
  assert.equal(await records.get(row.pk, row.sk), null);
  assert.equal(await deliver(), false);
  const history = await messages();
  assert.equal(history.length, 2);
  const reply = history[1];
  assert.equal(reply.replyTo, source.messageId);
  assert.equal(reply.senderId, 'lead');
  assert.equal(reply.text, 'The goal is complete. Goal ID ' + goal.id + '.');
  assert.deepEqual(reply.responders, []);
  assert.deepEqual((await conversations.execute('owner', 'messages.status', { conversationId: source.conversationId,
    messageId: reply.id })).deliveries, []);
});

test('current membership gates posting and temporary inactivity retains the notice until resume', async t => {
  const { records, people, row, source, deliver, messages } = await setup(t);
  people.get('lead').desiredState = 'paused';
  await assert.rejects(deliver(), { status: 403 });
  assert.ok(await records.get(row.pk, row.sk));
  assert.equal((await messages()).length, 1);
  people.get('lead').desiredState = 'active';
  // Simulate a membership change before dispatch against the real conversation access check.
  const { pk, sk, version, ...conv } = await records.get('CONVERSATIONS', 'C#' + source.conversationId);
  await records.transact([{ pk, sk, expect: version, value: { ...conv, members: ['owner', 'engineer'] } }]);
  assert.equal(await deliver(), true);
  assert.equal(await records.get(row.pk, row.sk), null);
  assert.equal((await messages()).length, 1);
});

test('temporary conversation failures preserve the outbox for a later poll', async t => {
  const { records, row, deliver, messages } = await setup(t);
  const transient = { execute: async () => { throw Object.assign(new Error('Network unavailable'), { status: 503 }); } };
  await assert.rejects(deliver({ conversations: transient }), { status: 503 });
  assert.ok(await records.get(row.pk, row.sk));
  assert.equal(await deliver(), true);
  assert.equal((await messages()).length, 2);
});
