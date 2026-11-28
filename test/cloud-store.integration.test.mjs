import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createCloudStore } from '../src/cloud-store.mjs';

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('DynamoDB integration tests require an explicit local emulator URL.');
}

test('bootstrap reconciles a transaction cancellation when per-item reasons are unavailable', async () => {
  const directory = { id: 'ceo', name: 'Mara', role: 'CEO', handle: 'mara' };
  let cold = true;
  const client = { async send(command) {
    switch (command.constructor.name) {
      case 'GetCommand': return { Item: cold ? undefined : directory };
      case 'TransactWriteCommand':
        cold = false;
        throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException' });
      case 'QueryCommand': return { Items: [directory] };
      default: throw new Error('Unexpected command');
    }
  } };
  assert.deepEqual(await createCloudStore({ tableName: 'test', client }).directory(), [directory]);
});

test('DynamoDB Local executes durable, fenced, ordered company transactions', { skip: !endpoint }, async t => {
  const name = 'perottino-test-' + randomUUID();
  const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const client = DynamoDBDocumentClient.from(raw);
  let clock = Date.now();
  const options = { tableName: name, client, now: () => clock };
  const store = createCloudStore(options);
  const another = createCloudStore(options);
  const request = async text => (await store.enqueue('ceo', text, randomUUID())).turnId;
  const acquire = async id => {
    const result = await store.claimTurn('ceo', id, 1000);
    assert.equal(result.state, 'claimed');
    return result.job;
  };
  const note = text => ({ id: randomUUID(), text, createdAt: new Date(clock).toISOString() });
  await raw.send(new CreateTableCommand({ TableName: name, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }]
  }));
  try {
    await waitUntilTableExists({ client: raw, maxWaitTime: 20, minDelay: 1, maxDelay: 2 }, { TableName: name });
    await t.test('bootstrap and HTTP request ids survive concurrent cold starts', async () => {
      const lists = await Promise.all([store.directory(), another.directory()]);
      for (const list of lists) assert.deepEqual(list, [{ id: 'ceo', name: 'Mara', role: 'CEO', handle: 'mara' }]);
      const equal = await Promise.all([store.enqueue('ceo', 'first', 'send-first'), another.enqueue('ceo', 'first', 'send-first')]);
      assert.equal(equal[0].turnId, equal[1].turnId);
      assert.equal((await another.enqueue('ceo', 'different', 'send-first')).conflict, true);
      const next = await request('second');
      const firstId = equal[0].turnId;
      const wake = await client.send(new GetCommand({ TableName: name, Key: { pk: 'AGENT#ceo', sk: 'PENDING#0000000000000001' } }));
      assert.deepEqual(wake.Item, { pk: 'AGENT#ceo', sk: 'PENDING#0000000000000001', kind: 'job',
        agentId: 'ceo', jobId: firstId, seq: 1, state: 'queued' });
      const turn = await client.send(new GetCommand({ TableName: name, Key: { pk: 'AGENT#ceo', sk: 'TURN#0000000000000001' } }));
      assert.equal(turn.Item.kind, 'turn');
      assert.equal(await store.turnAdmission('ceo', next), 'wait');
      assert.equal((await store.claimTurn('ceo', next, 1000)).state, 'busy');
      const competing = await Promise.all([store.claimTurn('ceo', firstId, 1000), another.claimTurn('ceo', firstId, 1000)]);
      assert.deepEqual(competing.map(x => x.state).sort(), ['busy', 'claimed']);
      const firstJob = competing.find(x => x.job).job;
      assert.equal(await store.turnAdmission('ceo', firstId), 'wait');
      assert.deepEqual(firstJob.history, []);
      clock += 1001;
      const fresh = await acquire(firstId);
      assert.equal(await store.complete(firstJob, 'stale', []), false);
      assert.equal(await store.release(firstJob), false);
      assert.equal(await store.fail(firstJob), false);
      const plan = note('ready');
      assert.equal(await store.complete(fresh, 'first reply', [plan, note('ready')]), true);
      assert.deepEqual(await store.finishTurnWithError('ceo', firstId), { status: 'done' });
      assert.equal(await store.turnAdmission('ceo', firstId), 'done');
      assert.equal((await store.claimTurn('ceo', firstId, 1000)).state, 'done');
      assert.equal(await store.turnAdmission('ceo', next), 'ready');
      const nextJob = await acquire(next);
      assert.deepEqual(nextJob.history.map(m => m.text), ['first', 'first reply']);
      assert.deepEqual(nextJob.memories.map(m => [m.text, m.sourceMessageId]), [['ready', firstId]]);
      assert.equal(await store.complete(nextJob, 'second reply', []), true);
    });
    await t.test('owner correction fences an in-flight turn and receipts survive replay and deletion', async () => {
      const id = await request('read my notes');
      const job = await acquire(id);
      const [saved] = await store.getMemories('ceo');
      // Force the two reads to straddle the winning transaction. Merely launching
      // parallel promises does not reproduce this interleaving on every emulator run.
      async function racingEdit(winnerRequestId, racingRequestId, text) {
        const read = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const delayed = createCloudStore({ ...options, client: { async send(command) {
          const result = await client.send(command);
          if (command instanceof GetCommand && command.input.Key.sk.startsWith('NOTE#')) {
            read.resolve();
            await resume.promise;
          }
          return result;
        } } });
        const second = delayed.changeMemory('ceo', saved.id, 'PATCH', racingRequestId, text);
        await read.promise;
        try {
          assert.equal(await store.changeMemory('ceo', saved.id, 'PATCH', winnerRequestId, text), 'ok');
        } finally { resume.resolve(); }
        assert.equal(await second, 'ok');
      }
      await racingEdit('other-1', 'other-2', 'intermediate');
      await racingEdit('fix', 'fix', 'revised');
      assert.equal(await store.changeMemory('ceo', saved.id, 'PATCH', 'fix', 'conflicting edit'), 'conflict');
      assert.equal(await store.complete(job, 'outdated reply', [note('outdated')]), false);
      const reloaded = await acquire(id);
      assert.equal(reloaded.memories[0].text, 'revised');
      assert.equal(reloaded.memories[0].updatedBy, 'owner');
      assert.equal(reloaded.memories[0].sourceMessageId, saved.sourceMessageId);
      await store.complete(reloaded, 'revised reply', [note('another note')]);
      assert.equal(await store.changeMemory('ceo', saved.id, 'PATCH', 'collision', 'another note'), 'duplicate');
      assert.equal(await store.changeMemory('ceo', saved.id, 'DELETE', 'forget'), 'ok');
      assert.equal(await store.changeMemory('ceo', saved.id, 'DELETE', 'forget'), 'ok');
      assert.equal(await store.changeMemory('ceo', saved.id, 'PATCH', 'fix', 'revised'), 'ok');
      assert.deepEqual((await store.getMemories('ceo')).map(m => m.text), ['another note']);
    });
    await t.test('out-of-order terminal errors and exhausted retries free the queue', async () => {
      assert.equal(await store.turnAdmission('ceo', 'missing'), 'failed');
      assert.deepEqual(await store.finishTurnWithError('ceo', 'missing'), { status: 'failed' });
      const ids = await Promise.all([request('third'), request('fourth'), request('fifth')]);
      const turns = (await store.messages('ceo')).messages.filter(m => ids.includes(m.id)).map(m => m.id);
      assert.equal(turns.length, 3);
      const [a, b, c] = turns;
      const timer = await acquire(a);
      await store.finishTurnWithError('ceo', b);
      assert.equal(await store.turnAdmission('ceo', c), 'wait');
      assert.deepEqual(await store.finishTurnWithError('ceo', a), { status: 'active' });
      clock += 1001;
      assert.deepEqual(await store.finishTurnWithError('ceo', a), { status: 'failed' });
      assert.equal(await store.complete(timer, 'too late', []), false);
      assert.equal(await store.turnAdmission('ceo', c), 'ready');
      for (let i = 0; i < 3; i++) { await acquire(c); clock += 1001; }
      assert.equal((await store.claimTurn('ceo', c, 1000)).state, 'error');
      assert.equal((await store.messages('ceo')).status, 'error');
      assert.equal(await store.turnAdmission('ceo', c), 'failed');
      const newId = await request('recovered');
      const newJob = await acquire(newId);
      await store.complete(newJob, 'ok', []);
      assert.equal((await store.messages('ceo')).status, 'idle');
    });
    await t.test('bounded responses retain older messages, individual errors, and memory sources', async () => {
      const id = await request('remember several notes');
      const work = await acquire(id);
      const notes = Array.from({ length: 32 }, (_, i) => note('note-' + i));
      assert.equal(await store.complete(work, 'saved them', notes), true);
      const firstNotes = await store.memoryPage('ceo');
      assert.equal(firstNotes.memories.length, 20);
      const olderNotes = await store.memoryPage('ceo', firstNotes.nextCursor);
      assert.equal(new Set([...firstNotes.memories, ...olderNotes.memories].map(m => m.id)).size, 33);
      const source = await store.messageSource('ceo', id);
      assert.equal(source.text, 'remember several notes');
      assert.equal(await store.messageSource('another-agent', id), null);
      await assert.rejects(store.memoryPage('ceo', 'META'), RangeError);
      for (let i = 0; i < 11; i++) {
        const pending = await request('page-' + i);
        await store.finishTurnWithError('ceo', pending);
      }
      const first = await store.messagePage('ceo');
      assert.equal(first.messages.length, 10);
      assert.equal(first.status, 'error');
      assert.equal(first.messages.at(-1).text, 'page-10');
      assert.equal(first.messages[0].text, 'page-1');
      assert.equal(first.messages[0].status, 'error');
      const older = await store.messagePage('ceo', first.nextCursor);
      assert.equal(older.messages.at(-1).text, 'page-0');
      await assert.rejects(store.messagePage('ceo', 'pending'), RangeError);
    });
  } finally {
    try { await raw.send(new DeleteTableCommand({ TableName: name })); } finally { raw.destroy(); }
  }
});
