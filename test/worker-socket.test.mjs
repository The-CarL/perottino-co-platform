import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDecisionServer, listenDecisionServer, runTurn } from '../src/agent.mjs';

function isolatedConfig(t, socket) {
  const settings = {
    PEROTTINO_AGENT_MODE: 'bedrock',
    PEROTTINO_BEDROCK_WORKER_SOCKET: socket,
    PEROTTINO_BEDROCK_WORKER_TOKEN: 't'.repeat(40),
    PEROTTINO_BEDROCK_WORKER_URL: undefined,
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
const chat = () => runTurn({ agent: { name: 'Mara', role: 'CEO' }, message: { text: 'Hello' } });

test('separate worker can be replaced through its authenticated Unix socket', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'co-ipc-'));
  const socket = path.join(dir, 'decision.sock');
  isolatedConfig(t, socket);
  const first = await listenDecisionServer(createDecisionServer(async () => ({ action: 'reply', value: 'first' })));
  let second;
  try {
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    assert.equal(await chat(), 'first');
    const previousTarget = await readlink(socket);
    second = await listenDecisionServer(createDecisionServer(async () => ({ action: 'reply', value: 'replacement' })));
    assert.notEqual(await readlink(socket), previousTarget);
    // The former worker's shutdown must leave the replacement reachable.
    await new Promise(resolve => first.close(resolve));
    assert.equal(await chat(), 'replacement');
    process.env.PEROTTINO_BEDROCK_WORKER_TOKEN = 'x'.repeat(40);
    await assert.rejects(chat(), /Bedrock worker/);
  } finally {
    if (first.listening) await new Promise(resolve => first.close(resolve));
    if (second?.listening) await new Promise(resolve => second.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('socket startup preserves unrelated files and rejects ambiguous transport configuration', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'co-ipc-'));
  const socket = path.join(dir, 'decision.sock');
  isolatedConfig(t, socket);
  try {
    await writeFile(socket, 'untouched');
    await assert.rejects(listenDecisionServer(), { code: 'EINVAL' });
    assert.equal(await readFile(socket, 'utf8'), 'untouched');
    process.env.PEROTTINO_BEDROCK_WORKER_URL = 'https://example.invalid';
    await assert.rejects(chat(), /either a worker socket or a worker URL/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
