import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDispatchHandlers } from '../src/dispatch.mjs';

const stateMachineArn = 'arn:aws:states:us-east-1:111111111111:stateMachine:company-turns';
const ok = { batchItemFailures: [] };
function record(sequence, requestId = sequence, kind = 'job', state = 'queued') {
  const jobId = createHash('sha256').update('ceo\0' + requestId).digest('hex');
  return {
    eventSource: 'aws:dynamodb', eventName: 'INSERT',
    dynamodb: { SequenceNumber: sequence, NewImage: {
      pk: { S: 'AGENT#ceo' }, sk: { S: 'PENDING#' + sequence.padStart(16, '0') },
      kind: { S: kind }, state: { S: state }, agentId: { S: 'ceo' }, jobId: { S: jobId },
      text: { S: 'Private message body' },
    } },
  };
}

test('only new queued turns start Standard executions with stable names and minimal input', async () => {
  const calls = [];
  const dispatcher = createDispatchHandlers({ stateMachineArn, startExecution: async input => calls.push(input) });
  const queued = record('100'), jobId = queued.dynamodb.NewImage.jobId.S;
  const event = { Records: [
    record('97', 'a', 'memory'), record('98', 'b', 'job', 'done'),
    { ...record('99'), eventName: 'MODIFY' }, queued,
  ] };
  assert.deepEqual(await dispatcher.handler(event), ok);
  assert.deepEqual(await dispatcher.handler({ Records: [queued] }), ok);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { stateMachineArn, name: 'turn-' + jobId, input: JSON.stringify({ agentId: 'ceo', jobId }) });
  assert.deepEqual(calls[0], calls[1]);
});

test('a replay accepts a closed duplicate and checkpoints the first unsuccessful sequence', async () => {
  const [first, second, third] = ['200', '201', '202'].map(value => record(value));
  const names = [first, second, third].map(item => 'turn-' + item.dynamodb.NewImage.jobId.S);
  const calls = [], diagnostics = [];
  let throttled = true;
  const dispatcher = createDispatchHandlers({
    stateMachineArn, startExecution: async ({ name }) => {
      calls.push(name);
      if (name === names[0]) throw Object.assign(new Error('closed'), { name: 'ExecutionAlreadyExists' });
      if (name === names[1] && throttled) throw Object.assign(new Error('transient'), { name: 'ThrottlingException' });
    },
    reportFailure: (...args) => diagnostics.push(args),
  });
  assert.deepEqual(await dispatcher.handler({ Records: [first, second, third] }),
    { batchItemFailures: [{ itemIdentifier: '201' }] });
  assert.deepEqual(calls, names.slice(0, 2));
  assert.equal(diagnostics.length, 1);
  throttled = false;
  assert.deepEqual(await dispatcher.handler({ Records: [second, third] }), ok);
  assert.deepEqual(calls, [names[0], names[1], names[1], names[2]]);
});

test('invalid durable keys retry for redrive; a missing checkpoint fails the whole invocation', async () => {
  const dispatcher = createDispatchHandlers({ stateMachineArn, reportFailure() {},
    startExecution: () => assert.fail('must not start a malformed job') });
  const bad = record('300');
  bad.dynamodb.NewImage.pk.S = 'AGENT#someone-else';
  assert.deepEqual(await dispatcher.handler({ Records: [bad] }), { batchItemFailures: [{ itemIdentifier: '300' }] });
  delete bad.dynamodb.SequenceNumber;
  await assert.rejects(dispatcher.handler({ Records: [bad] }), /sequence number/);
  await assert.rejects(dispatcher.handler({}), /Streams batch/);
});

test('admission and terminal handling address exactly the immutable job, without launching work', async () => {
  const calls = [], job = { agentId: 'ceo', jobId: '0'.repeat(64) };
  const handlers = createDispatchHandlers({ getStore: () => ({
    turnAdmission: async (...keys) => { calls.push(['read', ...keys]); return 'wait'; },
    finishTurnWithError: async (...keys) => { calls.push(['fail', ...keys]); return { status: 'active' }; },
  }) });
  assert.deepEqual(await handlers.admit(job), { status: 'wait' });
  assert.deepEqual(await handlers.terminal(job), { status: 'active' });
  assert.deepEqual(calls, [['read', job.agentId, job.jobId], ['fail', job.agentId, job.jobId]]);
  await assert.rejects(handlers.terminal({ agentId: 'ceo', jobId: '' }), /identifiers/);
  assert.equal(calls.length, 2);
});

test('the workflow sees distinct completed, missing or failed, and still-active decisions', async () => {
  const job = { agentId: 'ceo', jobId: 'a'.repeat(64) };
  for (const status of ['ready', 'wait', 'done', 'failed']) {
    const handlers = createDispatchHandlers({ getStore: () => ({ turnAdmission: async () => status }) });
    assert.deepEqual(await handlers.admit(job), { status });
  }
  for (const status of ['done', 'failed', 'active']) {
    const handlers = createDispatchHandlers({ getStore: () => ({ finishTurnWithError: async () => ({ status }) }) });
    assert.deepEqual(await handlers.terminal(job), { status });
  }
});
