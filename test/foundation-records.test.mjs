import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeDynamoRecords, makeSqliteRecords } from '../src/foundation-records.mjs';

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;
if (endpoint && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/.test(endpoint)) {
  throw new Error('Foundation record tests require a loopback DynamoDB Local endpoint.');
}
const change = (pk, sk, expect, value) => ({ pk, sk, expect, value });

async function contract(open) {
  const a = open(), b = open();
  try {
    assert.equal(await a.get('work', 'head'), null);
    const issued = { title: 'First', revision: 9, meta: { accepted: false }, labels: ['test'] };
    assert.equal(await a.transact([change('work', 'head', null, issued), change('outbox', '001', null, { state: 'queued' })]), true);
    assert.deepEqual(await b.get('work', 'head'), { pk: 'work', sk: 'head', version: 1, ...issued });
    assert.equal(await b.transact([change('outbox', '002', null, {}), change('work', 'head', null, { title: 'Overwrite' })]), false);
    assert.equal(await a.get('outbox', '002'), null);

    const writers = await Promise.all([a, b].map((s, index) => s.transact([change('work', 'head', 1, { index })])));
    assert.deepEqual(writers.toSorted(), [false, true]);
    const winner = await b.get('work', 'head');
    assert.deepEqual(winner, { pk: 'work', sk: 'head', version: 2, index: writers.indexOf(true) });
    assert.equal(await a.transact([change('work', 'head', winner.version, null)]), true);
    assert.equal(await b.get('work', 'head'), null);
    assert.equal(await b.transact([change('work', 'head', null, null)]), true);
    assert.equal(await a.transact([change('work', 'head', null, { text: 'Recreated' })]), true);
    assert.ok((await b.get('work', 'head')).version > winner.version);
    assert.equal(await b.transact([change('work', 'head', winner.version, {})]), false);

    const sorted = ['A', 'a%', 'a_1', 'a_2', 'a_3', 'b', 'é', '💡'];
    await a.transact(sorted.toReversed().map(sk => change('ordered', sk, null, {})));
    assert.deepEqual((await b.list('ordered')).items.map(r => r.sk), sorted);
    const first = await b.list('ordered', { prefix: 'a_', limit: 2 });
    assert.deepEqual(first.items.map(r => r.sk), ['a_1', 'a_2']);
    assert.equal(first.next, 'a_2');
    const final = await b.list('ordered', { prefix: 'a_', after: first.next, limit: 1 });
    assert.deepEqual(final.items.map(r => r.sk), ['a_3']);
    assert.equal(final.next, undefined);
    assert.deepEqual((await b.list('ordered', { prefix: 'a_', after: 'b' })).items, []);
    assert.deepEqual((await b.list('ordered', { prefix: 'a_', after: 'A' })).items.map(r => r.sk), ['a_1', 'a_2', 'a_3']);
    await a.transact([change('ordered', 'a_2', 1, null), change('ordered', 'a_3', 1, null)]);
    const only = await b.list('ordered', { prefix: 'a_', limit: 1 });
    assert.deepEqual(only.items.map(r => r.sk), ['a_1']);
    assert.equal(only.next, undefined);

    for (const value of [{ pk: 'oops' }, { version: 3 }, { missing: undefined }, { kind: Infinity },
      { nested: JSON.parse('{"__proto__":{"polluted":true}}') }, { nested: { constructor: 'bad' } }]) {
      await assert.rejects(a.transact([change('bad', 'value', null, value)]));
    }
    await assert.rejects(a.transact([change('bad', 'value', undefined, {})]));
    await assert.rejects(a.transact([change('bad', 'value', null, {}), change('bad', 'value', null, {})]));
    await assert.rejects(a.transact(Array.from({ length: 101 }, (_, i) => change('bad', String(i), null, {}))));
    assert.deepEqual((await a.list('bad')).items, []);
    await assert.rejects(a.get('work', '\ud800'));
  } finally { a.close(); b.close(); }
}

test('versioned SQLite records share commits across connections and fence obsolete writes after reopening', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'company-records-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => makeSqliteRecords({ filename: join(dir, 'company.sqlite') });
  await contract(open);
  const reopened = open();
  try { assert.equal((await reopened.get('work', 'head')).text, 'Recreated'); }
  finally { reopened.close(); }
});

test('DynamoDB Local has the same contract, guards, key isolation and pagination across 1 MB', { skip: !endpoint }, async t => {
  const tableName = 'foundation-records-' + randomUUID();
  const raw = new DynamoDBClient({ region: 'us-east-1', endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const client = DynamoDBDocumentClient.from(raw);
  await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })) }));
  t.after(async () => { try { await raw.send(new DeleteTableCommand({ TableName: tableName })); } finally { raw.destroy(); } });
  await waitUntilTableExists({ client: raw, maxWaitTime: 20, minDelay: 1, maxDelay: 1 }, { TableName: tableName });
  const open = args => makeDynamoRecords({ tableName, client, ...args });
  const legacy = (pk, sk, attributes) => client.send(new PutCommand({ TableName: tableName, Item: { pk, sk, ...attributes } }));
  await legacy('work', 'head', { version: 999, data: 'private legacy record' });
  await contract(open);

  const records = open();
  await legacy('V2#occupied', 'foreign', { existing: true });
  assert.equal(await records.transact([change('occupied', 'foreign', null, { text: 'Unrelated' })]), false);
  const chunk = 'x'.repeat(220_000);
  await records.transact(Array.from({ length: 7 }, (_, i) => change('large', String(i), null, { chunk })));
  const large = await records.list('large', { limit: 6 });
  assert.equal(large.items.length, 6);
  assert.equal(large.next, '5');
  assert.equal((await records.list('large', { after: large.next })).items[0].sk, '6');

  const condition = { ConditionCheck: { Key: { pk: 'DIRECTORY', sk: 'AGENT#test' },
    ConditionExpression: '#g = :generation', ExpressionAttributeNames: { '#g': 'generation' },
    ExpressionAttributeValues: { ':generation': 1 } } };
  const guarded = open({ conditions: [condition] });
  const work = change('guarded', 'item', null, { approved: true });
  await assert.rejects(guarded.transact([work]), { status: 403, code: 'FOUNDATION_GUARD_DENIED' });
  assert.equal(await records.get('guarded', 'item'), null);
  await legacy('DIRECTORY', 'AGENT#test', { generation: 1 });
  assert.equal(await guarded.transact([work]), true);
  assert.equal(await guarded.transact([work]), false);
  await legacy('DIRECTORY', 'AGENT#test', { generation: 2 });
  await assert.rejects(guarded.transact([change('guarded', 'item', 1, null)]), { status: 403 });
  assert.equal((await records.get('guarded', 'item')).approved, true);
  await assert.rejects(guarded.transact(Array.from({ length: 100 }, (_, i) => change('guarded', String(i), null, {}))));
  assert.throws(() => open({ conditions: [condition, condition] }));
});
