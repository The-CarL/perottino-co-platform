import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCloudTurn, workerExit } from '../src/cloud-worker.mjs';

function fixture(text = 'Prepare an update') {
  const job = { agent: { id: 'ceo', name: 'Mara', role: 'CEO' },
    message: { id: 'turn-a', text }, token: 'fenced-token', memoryRevision: 7, history: [], memories: [] };
  const events = [];
  const store = {
    async claimTurn(agentId, turnId, leaseMs) {
      events.push('claim'); assert.equal(agentId, 'ceo'); assert.equal(turnId, 'turn-a');
      assert.equal(leaseMs, 150_000); return { state: 'claimed', job };
    },
    async complete(received, reply, notes) {
      assert.equal(received, job); events.push({ reply, notes }); return true;
    },
    async release(received) { assert.equal(received, job); events.push('release'); return true; },
  };
  return { events, job, options: { store, agentId: 'ceo', turnId: 'turn-a' } };
}

test('cloud turn uses Bedrock decisions, stages memory, and commits reply and source notes together', async () => {
  const { options, events } = fixture();
  let calls = 0;
  options.decide = async (context, signal) => {
    signal.throwIfAborted(); calls++;
    if (!context.observations.length) return { action: 'remember', value: 'The preview is ready.' };
    assert.equal(context.observations[0].result, 'Remembered: The preview is ready.');
    return { action: 'reply', value: 'Preview handoff is ready.' };
  };
  assert.equal(await executeCloudTurn(options), workerExit.done);
  assert.equal(calls, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].reply, 'Preview handoff is ready.');
  assert.deepEqual(events[1].notes.map(n => [n.text, n.sourceMessageId]), [['The preview is ready.', 'turn-a']]);
});

test('duplicate, blocked and failed turns do not spend inference or produce a synthetic reply', async () => {
  for (const [state, code] of [['done', 0], ['error', 0], ['busy', 75]]) {
    const { options, events } = fixture();
    options.store.claimTurn = async () => ({ state });
    options.decide = () => assert.fail('unexpected inference');
    assert.equal(await executeCloudTurn(options), code);
    assert.deepEqual(events, []);
  }
  const { options, events } = fixture();
  options.decide = async ctx => {
    if (!ctx.observations.length) return { action: 'remember', value: 'Pending.' };
    throw new Error('provider unavailable');
  };
  await assert.rejects(executeCloudTurn(options), /provider unavailable/);
  assert.deepEqual(events, ['claim', 'release']);
});

test('lost completion lease and cancellation before commit leave work recoverable', async () => {
  const { options, events } = fixture();
  options.decide = async () => ({ action: 'reply', value: 'OK' });
  options.store.complete = async () => false;
  assert.equal(await executeCloudTurn(options), workerExit.busy);
  assert.deepEqual(events, ['claim', 'release']);
  const aborted = fixture();
  const stop = new AbortController();
  aborted.options.signal = stop.signal;
  aborted.options.decide = async () => {
    stop.abort(new Error('shutdown')); return { action: 'reply', value: 'Must be discarded' };
  };
  await assert.rejects(executeCloudTurn(aborted.options), /shutdown/);
  assert.deepEqual(aborted.events, ['claim', 'release']);
});

test('cloud browser infrastructure failures retry and owner document errors return a helpful reply', async () => {
  const unavailable = fixture('browse https://example.com');
  unavailable.options.browse = async () => { throw Object.assign(new Error('unavailable'), { code: 'BROWSER_RENDER_FAILED' }); };
  await assert.rejects(executeCloudTurn(unavailable.options), /unavailable/);
  assert.deepEqual(unavailable.events, ['claim', 'release']);
  const denied = fixture('browse http://localhost');
  denied.options.browse = async () => { throw new Error('Browsing is limited to public web destinations.'); };
  assert.equal(await executeCloudTurn(denied.options), 0);
  assert.match(denied.events[1].reply, /public web destinations/);
});
