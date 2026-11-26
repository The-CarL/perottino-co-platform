import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createDecisionServer, runTurn } from '../src/agent.mjs';

function employee() {
  const notes = [];
  return {
    agent: { name: 'Mara', role: 'CEO' }, history: [], memories: notes,
    async remember(text) { const note = { text }; notes.push(note); return note; },
    async recall(query) { return notes.filter(note => note.text.includes(query)); },
    async browse(url) { return { url, title: 'Waste reuse', text: 'Survey results.' }; },
  };
}
const message = (worker, text) => runTurn({ ...worker, message: { id: 'm1', text } });

test('local mode saves, retrieves, browses, and explains its supported commands', async t => {
  const previous = process.env.PEROTTINO_AGENT_MODE;
  process.env.PEROTTINO_AGENT_MODE = 'local';
  t.after(() => { if (previous === undefined) delete process.env.PEROTTINO_AGENT_MODE;
    else process.env.PEROTTINO_AGENT_MODE = previous; });
  const worker = employee();
  assert.match(await message(worker, 'hello'), /Mara.*CEO.*local mode/s);
  assert.match(await message(worker, 'remember the launch is Friday'), /Remembered: the launch is Friday/);
  assert.match(await message(worker, 'recall launch'), /the launch is Friday/);
  assert.match(await message(worker, 'recall missing'), /no notes matching/);
  assert.match(await message(worker, 'recall'), /launch is Friday/);
  assert.match(await message(worker, 'browse https://example.com'), /Waste reuse.*https:\/\/example.com.*Survey/s);
  assert.match(await message(worker, 'browse'), /Which page/);
  worker.browse = async () => { throw new Error('secret internal message'); };
  assert.doesNotMatch(await message(worker, 'browse https://example.org'), /secret/);
});

test('Bedrock transport authenticates and handles only validated scoped tool requests', async t => {
  const vars = ['PEROTTINO_AGENT_MODE', 'PEROTTINO_BEDROCK_WORKER_TOKEN', 'PEROTTINO_BEDROCK_WORKER_URL'];
  const previous = new Map(vars.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.PEROTTINO_AGENT_MODE = 'bedrock';
  process.env.PEROTTINO_BEDROCK_WORKER_TOKEN = 'x'.repeat(48);
  let calls = 0;
  const backend = createDecisionServer(async ctx => {
    calls++;
    if (ctx.message === 'invalid') return { action: 'exec', value: 'ignored' };
    if (!ctx.observations.length) return { action: 'remember', value: 'The draft is ready.' };
    assert.equal(ctx.observations[0].result, 'Remembered: The draft is ready.');
    return { action: 'reply', value: 'I saved the draft status.' };
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const origin = 'http://127.0.0.1:' + backend.address().port;
  process.env.PEROTTINO_BEDROCK_WORKER_URL = origin;
  assert.equal((await fetch(origin + '/decision', { method: 'POST' })).status, 401);
  const worker = employee();
  assert.equal(await message(worker, 'Keep track of our draft'), 'I saved the draft status.');
  assert.deepEqual(worker.memories, [{ text: 'The draft is ready.' }]);
  assert.equal(calls, 2);
  await assert.rejects(message(worker, 'invalid'), /Bedrock worker/);
});
