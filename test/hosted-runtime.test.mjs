import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { hashPassword } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';

async function until(read) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const result = read();
    if (result) return result;
    await wait(20);
  }
  throw new Error('Worker did not reach the expected state.');
}

test('a failed commit retains the turn for a durable retry', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'co-storage-test-'));
  const store = createStore(dataDir);
  const db = new DatabaseSync(path.join(dataDir, 'company.sqlite'));
  let app;
  try {
    store.enqueue('ceo', 'Save the plan', 'owner-1');
    db.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE OF reply ON turn
      BEGIN SELECT RAISE(ABORT, 'simulated storage interruption'); END`);
    let attempts = 0;
    app = createApp({ dataDir, username: 'owner', passwordHash: await hashPassword('test-only-strong-password'),
      runner: async ({ remember }) => { attempts++; remember('Durable plan'); return 'Saved it'; } });
    await until(() => attempts > 0);
    assert.equal(store.messages('ceo').status, 'working');
    assert.deepEqual(store.getMemories('ceo'), []);
    db.exec('DROP TRIGGER fail_commit; UPDATE turn SET lease_until=0');
    await until(() => store.messages('ceo').status === 'idle');
    assert.equal(attempts, 2);
    assert.deepEqual(store.messages('ceo').messages.map(m => m.text), ['Save the plan', 'Saved it']);
    assert.equal(store.getMemories('ceo').length, 1);
  } finally {
    await app?.close();
    db.close(); store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('live mode validates the worker transport before opening the store or ingress', t => {
  const vars = ['PEROTTINO_AGENT_MODE', 'PEROTTINO_BEDROCK_WORKER_TOKEN', 'PEROTTINO_BEDROCK_WORKER_URL', 'PEROTTINO_BEDROCK_WORKER_SOCKET'];
  const old = vars.map(key => process.env[key]);
  t.after(() => vars.forEach((key, i) => {
    if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
  }));
  process.env.PEROTTINO_AGENT_MODE = 'bedrock';
  for (const key of vars.slice(1)) delete process.env[key];
  assert.throws(() => createApp(), /worker authentication token/);
  process.env.PEROTTINO_BEDROCK_WORKER_TOKEN = 'x'.repeat(40);
  assert.throws(() => createApp(), /worker URL/);
});

test('repeated crashed leases stop after three charged attempts; clean handoffs still recover', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'co-crash-test-'));
  const store = createStore(dir);
  try {
    store.enqueue('ceo', 'Pilot budget', 'owner-9');
    for (let i = 0; i < 5; i++) store.release(store.claim(10000));
    for (let i = 0; i < 3; i++) assert.ok(store.claim(0));
    assert.equal(store.claim(0), undefined);
    assert.equal(store.messages('ceo').status, 'error');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('retry accounting upgrades a prior pilot database without losing its queued turn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'co-upgrade-test-'));
  let store = createStore(dir);
  try {
    const expected = store.enqueue('ceo', 'Resume the pilot', 'owner-existing').message;
    store.close();
    const legacy = new DatabaseSync(path.join(dir, 'company.sqlite'));
    try { legacy.exec('ALTER TABLE turn DROP COLUMN attempts'); } finally { legacy.close(); }
    store = createStore(dir);
    const job = store.claim(10000);
    assert.equal(job.message.id, expected.id);
    assert.equal(store.complete(job, 'Resumed', []), true);
    assert.equal(store.messages('ceo').messages.at(-1).text, 'Resumed');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
