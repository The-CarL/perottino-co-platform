import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const namespace = 'V2#';
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const metadataKeys = new Set(['pk', 'sk', 'version']);

function key(value, max, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value) || !value.isWellFormed() ||
      value.includes('\0') || Buffer.byteLength(value) > max) throw new TypeError('Invalid record key.');
  return value;
}
const partition = pk => namespace + key(pk, 2048 - Buffer.byteLength(namespace));
const sortKey = sk => key(sk, 1024);

function encode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a record object.');
  for (const field of Object.keys(value)) if (metadataKeys.has(field)) throw new TypeError('Reserved record field.');
  // JSON stores one portable representation in both backends and prevents ambiguous omission of undefined.
  return JSON.stringify(value, function (field, item) {
    if (unsafeKeys.has(field)) throw new TypeError('Unsafe record field.');
    const original = this[field];
    if (original === null || ['boolean', 'string'].includes(typeof original) || Number.isFinite(original)) return item;
    if (Array.isArray(original) || (typeof original === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(original)))) {
      if (Object.getOwnPropertySymbols(original).length === 0 && !Object.hasOwn(original, 'toJSON')) return item;
    }
    throw new TypeError('Record values must be JSON data.');
  });
}

function writes(changes, guards = 0) {
  if (!Array.isArray(changes) || !changes.length || changes.length + guards > 100) throw new RangeError('Invalid record transaction size.');
  const seen = new Set();
  return changes.map(({ pk, sk, expect, value }) => {
    const physical = { pk: partition(pk), sk: sortKey(sk) };
    const address = JSON.stringify([physical.pk, physical.sk]);
    if (seen.has(address)) throw new TypeError('Duplicate record in transaction.');
    seen.add(address);
    if (expect !== null && (!Number.isSafeInteger(expect) || expect < 1 || expect >= Number.MAX_SAFE_INTEGER)) {
      throw new TypeError('Expected an explicit record version or null.');
    }
    return { ...physical, expect, data: value === null ? null : encode(value) };
  });
}

function listOptions({ prefix = '', limit = 100, after } = {}) {
  key(prefix, 1024, true);
  if (after !== undefined) sortKey(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid record page size.');
  return { prefix, limit, after };
}

function readRow(row) {
  return row?.data == null ? null :
    { pk: row.pk.slice(namespace.length), sk: row.sk, version: row.version, ...JSON.parse(row.data) };
}
function page(rows, limit) {
  const items = rows.slice(0, limit).map(readRow);
  return rows.length > limit ? { items, next: items.at(-1).sk } : { items };
}

export function makeSqliteRecords({ filename, db: suppliedDb }) {
  if (!suppliedDb && filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    closeSync(openSync(filename, 'a', 0o600));
  }
  const db = suppliedDb ?? new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS foundation_records (
      pk TEXT NOT NULL, sk TEXT NOT NULL, version INTEGER NOT NULL, data TEXT, PRIMARY KEY(pk, sk)
    ) WITHOUT ROWID;`);
  const select = db.prepare('SELECT * FROM foundation_records WHERE pk=? AND sk=?');
  const list = db.prepare(`SELECT * FROM foundation_records WHERE pk=? AND sk>=? AND sk>? AND data IS NOT NULL
    AND substr(sk,1,length(?))=? ORDER BY sk LIMIT ?`);
  const put = db.prepare(`INSERT INTO foundation_records (pk,sk,version,data) VALUES (?,?,1,?)
    ON CONFLICT(pk,sk) DO UPDATE SET version=version+1, data=excluded.data`);
  return {
    async get(pk, sk) { return readRow(select.get(partition(pk), sortKey(sk))); },
    async list(pk, options) {
      const { prefix, limit, after } = listOptions(options);
      return page(list.all(partition(pk), prefix, after ?? '', prefix, prefix, limit + 1), limit);
    },
    async transact(changes, authorize) {
      const batch = writes(changes);
      db.exec('BEGIN IMMEDIATE');
      try {
        authorize?.();
        for (const { pk, sk, expect, data } of batch) {
          const row = select.get(pk, sk);
          const version = row?.data == null ? null : row.version;
          if (version !== expect) { db.exec('ROLLBACK'); return false; }
          // Deletion keeps only the version, fencing stale writers even after the key is recreated.
          if (data !== null || expect !== null) put.run(pk, sk, data);
        }
        db.exec('COMMIT');
        return true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if (!suppliedDb) db.close(); },
  };
}

function dynamoWrite(tableName, { pk, sk, expect, data }) {
  const common = { TableName: tableName, Key: { pk, sk },
    ConditionExpression: expect === null ? '(attribute_not_exists(pk) OR (#gone = :yes AND attribute_not_exists(#d)))'
      : '#v = :expect AND attribute_exists(#d)',
    ExpressionAttributeNames: { '#d': 'data', '#gone': 'deleted' },
    ExpressionAttributeValues: expect === null ? { ':yes': true } : { ':expect': expect } };
  if (data === null && expect === null) return { ConditionCheck: common };
  return { Update: { ...common, ExpressionAttributeNames: { ...common.ExpressionAttributeNames, '#v': 'version' },
    UpdateExpression: 'SET #v = if_not_exists(#v,:zero) + :one' + (data === null ? ', #gone = :yes REMOVE #d' : ', #d = :data REMOVE #gone'),
    ExpressionAttributeValues: { ...common.ExpressionAttributeValues, ':zero': 0, ':one': 1,
      ...(data === null ? { ':yes': true } : { ':data': data }) } } };
}

function transactionGuards(tableName, conditions) {
  if (!Array.isArray(conditions) || conditions.length > 99) throw new TypeError('Invalid foundation guards.');
  const keys = new Set();
  return conditions.map(item => {
    const guard = structuredClone(item.ConditionCheck);
    if (!guard || (guard.TableName !== undefined && guard.TableName !== tableName) ||
        typeof guard.ConditionExpression !== 'string' || !guard.ConditionExpression) throw new TypeError('Invalid foundation guard.');
    const pk = key(guard.Key?.pk, 2048), sk = sortKey(guard.Key?.sk);
    const address = JSON.stringify([pk, sk]);
    if (pk.startsWith(namespace) || keys.has(address)) throw new TypeError('Invalid foundation guard key.');
    keys.add(address);
    return { ConditionCheck: { ...guard, TableName: tableName } };
  });
}

export function makeDynamoRecords({ tableName, client, conditions = [] }) {
  if (!tableName) throw new TypeError('Expected a DynamoDB table name.');
  const guards = transactionGuards(tableName, conditions);
  const raw = client ? null : new DynamoDBClient({});
  const ddb = client ?? DynamoDBDocumentClient.from(raw);
  return {
    async get(pk, sk) {
      const { Item } = await ddb.send(new GetCommand({ TableName: tableName, ConsistentRead: true, Key: { pk: partition(pk), sk: sortKey(sk) } }));
      return readRow(Item);
    },
    async list(pk, options) {
      const physical = partition(pk);
      const { prefix, limit, after } = listOptions(options);
      // DynamoDB rejects a cursor outside its key condition. Apply the public exclusive cursor
      // before constructing the request so arbitrary after values also work like SQLite.
      if (prefix && after && !after.startsWith(prefix) && Buffer.compare(Buffer.from(after), Buffer.from(prefix)) > 0) return { items: [] };
      let start = after && after.startsWith(prefix) ? { pk: physical, sk: after } : undefined;
      const rows = [];
      do {
        const result = await ddb.send(new QueryCommand({ TableName: tableName, ConsistentRead: true,
          KeyConditionExpression: 'pk = :pk' + (prefix ? ' AND begins_with(sk,:prefix)' : ''),
          FilterExpression: 'attribute_exists(#data)', ExpressionAttributeNames: { '#data': 'data' },
          ExpressionAttributeValues: { ':pk': physical, ...(prefix && { ':prefix': prefix }) },
          ExclusiveStartKey: start, Limit: Math.min(1000, limit + 1 - rows.length) }));
        rows.push(...(result.Items ?? []));
        start = result.LastEvaluatedKey;
      } while (start && rows.length <= limit);
      return page(rows, limit);
    },
    async transact(changes) {
      const batch = writes(changes, guards.length).map(change => dynamoWrite(tableName, change));
      try {
        await ddb.send(new TransactWriteCommand({ TransactItems: [...batch, ...guards] }));
        return true;
      } catch (error) {
        if (error.name === 'TransactionConflictException') return false;
        if (error.name !== 'TransactionCanceledException') throw error;
        const reasons = error.CancellationReasons ?? [];
        if (reasons.slice(batch.length).some(r => r.Code === 'ConditionalCheckFailed')) {
          throw Object.assign(new Error('The foundation write is no longer authorized.'), { status: 403, code: 'FOUNDATION_GUARD_DENIED' });
        }
        if (reasons.some(r => ['ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code)) &&
            reasons.every(r => ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) return false;
        throw error;
      }
    },
    close() { raw?.destroy(); },
  };
}
