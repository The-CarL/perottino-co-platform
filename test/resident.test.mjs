import assert from 'node:assert/strict';
import test from 'node:test';
import { executeResidentPulse, managerTool, readBinding, runResident } from '../src/resident.mjs';

const ceo = { id: 'ceo', handle: 'mara', name: 'Mara', role: 'CEO', canHire: true };
const engineer = { id: 'e-dev', handle: 'dev', name: 'Ada', role: 'Engineer', managerId: 'ceo', canHire: false };
const outsider = { id: 'e-other', handle: 'other', name: 'Sam', role: 'Reviewer', managerId: 'elsewhere' };
const binding = { agentId: 'ceo', generation: 2, taskArn: 'arn:aws:ecs:us-east-1:111111111111:task/company/' + 'a'.repeat(32) };
function fixture(text = 'Prepare an update') {
  const job = { agent: ceo, message: { id: 'turn-a', author: 'owner', text },
    token: 'fenced-token', memoryRevision: 7, history: [], memories: [] };
  const events = [];
  const store = {
    async claimNextWork(input) {
      assert.deepEqual(input, {...binding, leaseMs:150_000});
      events.push('claim'); return { state: 'claimed', kind: job.goal ? 'goal' : 'message', job };
    },
    async listEmployees() { return [ceo, engineer, outsider]; },
    async complete(received, reply, notes, goal) {
      assert.equal(received, job); events.push({ reply, notes, goal }); return true;
    },
    async checkpointGoal(received, patch) {
      assert.equal(received, job); events.push(patch); Object.assign(job.goal, patch);
      job.goal.stepCount++; return true;
    },
    async release(received) { assert.equal(received, job); events.push('release'); return true; },
  };
  return { events, job, options: { store, binding, now: () => 1000 } };
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
  assert.equal(await executeResidentPulse(options), 'worked');
  assert.equal(calls, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].reply, 'Preview handoff is ready.');
  assert.deepEqual(events[1].notes.map(n => [n.text, n.sourceMessageId]), [['The preview is ready.', 'turn-a']]);
});

test('inactive, idle and contended pulses spend no inference, and provider errors do not publish a reply', async () => {
  for (const state of ['idle', 'inactive', 'busy']) {
    const { options, events } = fixture();
    options.store.claimNextWork = async () => ({ state });
    options.decide = () => assert.fail('unexpected inference');
    assert.equal(await executeResidentPulse(options), state);
    assert.deepEqual(events, []);
  }
  const { options, events } = fixture();
  options.decide = async ctx => {
    if (!ctx.observations.length) return { action: 'remember', value: 'Pending.' };
    throw new Error('provider unavailable');
  };
  await assert.rejects(executeResidentPulse(options), /provider unavailable/);
  assert.deepEqual(events, ['claim', 'release']);
});

test('lost completion lease and cancellation before commit leave work recoverable', async () => {
  const { options, events } = fixture();
  options.decide = async () => ({ action: 'reply', value: 'OK' });
  options.store.complete = async () => false;
  assert.equal(await executeResidentPulse(options), 'busy');
  assert.deepEqual(events, ['claim', 'release']);
  const aborted = fixture();
  const stop = new AbortController();
  aborted.options.signal = stop.signal;
  aborted.options.decide = async () => {
    stop.abort(new Error('shutdown')); return { action: 'reply', value: 'Must be discarded' };
  };
  await assert.rejects(executeResidentPulse(aborted.options), /shutdown/);
  assert.deepEqual(aborted.events, ['claim', 'release']);
});

test('cloud browser infrastructure failures retry and owner document errors return a helpful reply', async () => {
  const unavailable = fixture('browse https://example.com');
  unavailable.options.browse = async () => { throw Object.assign(new Error('unavailable'), { code: 'BROWSER_RENDER_FAILED' }); };
  await assert.rejects(executeResidentPulse(unavailable.options), /unavailable/);
  assert.deepEqual(unavailable.events, ['claim', 'release']);
  const denied = fixture('browse http://localhost');
  denied.options.browse = async () => { throw new Error('Browsing is limited to public web destinations.'); };
  assert.equal(await executeResidentPulse(denied.options), 'worked');
  assert.match(denied.events[1].reply, /public web destinations/);
});

test('owner chat becomes durable work and fresh pulses plan, execute, and recover a confirmed hire once', async () => {
  const { options, events, job } = fixture('Staff a project to prepare a dataset report.');
  options.decide = async context => {
    assert.equal(context.kind, 'message');
    assert.equal(context.sender.author, 'owner');
    return { action: 'goal', value: 'Prepare the dataset report.' };
  };
  assert.equal(await executeResidentPulse(options), 'worked');
  const goal = events.at(-1).goal;
  assert.equal(goal.text, 'Prepare the dataset report.');
  job.goal = { ...goal, source: 'message', id: 'goal-a', stepCount: 0 };
  options.decide = async context => {
    assert.equal(context.kind, 'goal');
    assert.equal(context.agent.canHire, true);
    return { action: 'hire', target: 'Engineer', value: 'Check the public data.' };
  };
  await executeResidentPulse(options);
  const pending = JSON.parse(job.goal.checkpoint).pending;
  assert.match(pending.requestId, /^[a-f0-9]{64}$/);
  assert.equal(pending.target, 'Engineer');
  let operations = new Map(), calls = 0;
  options.decide = () => assert.fail('A durable pending action must be replayed without inference');
  options.recruit = async request => {
    assert.deepEqual(request, { operation: 'hire', role: 'Engineer', assignment: 'Check the public data.', requestId: pending.requestId });
    operations.set(request.requestId, engineer);
    if (!calls++) throw new Error('lost factory response');
    return { ok: true, employee: engineer };
  };
  await assert.rejects(executeResidentPulse(options), /lost factory response/);
  assert.equal(JSON.parse(job.goal.checkpoint).pending.requestId, pending.requestId);
  await executeResidentPulse(options);
  assert.equal(operations.size, 1);
  assert.match(JSON.parse(job.goal.checkpoint).progress.at(-1), /Hired Ada/);
  assert.equal(JSON.parse(job.goal.checkpoint).pending, undefined);
  options.decide = () => ({ action: 'finish', value: 'Ada has the source verification assignment.' });
  await executeResidentPulse(options);
  assert.equal(job.goal.status, 'done');
});

test('verified goal steps save future wake times, browser observations, and a final deliverable', async () => {
  const { options, job } = fixture();
  job.goal = { id: 'g', source: 'manager', text: 'Summarize a public dataset.', stepCount: 0, checkpoint: '' };
  options.decide = context => {
    assert.deepEqual(context.sender, { author: 'goal', source: 'manager' });
    return { action: 'browse', value: 'https://example.test' };
  };
  options.browse = async (_url, {signal}) => { signal.throwIfAborted(); return {url: 'https://example.test/',title:'Report',text:'Ten rows.'}; };
  await executeResidentPulse(options);
  options.decide = context => {
    assert.match(context.goal.progress.join(' '), /Ten rows/);
    return { action: 'wait', value: 'Waiting for reviewed data.', delaySeconds: 600 };
  };
  await executeResidentPulse(options);
  assert.equal(job.goal.status, 'waiting');
  assert.equal(job.goal.nextRunAt, 601000);
  options.decide = () => ({ action: 'finish', value: 'Reviewed all ten rows.' });
  await executeResidentPulse(options);
  assert.equal(job.goal.status, 'done');
});

test('manager-assigned goals constrain dismissal to own reports and block management by individual contributors', async () => {
  for (const [actor, target, expectDispatch] of [[ceo, '@dev', true], [ceo, '@other', false], [engineer, '@other', false]]) {
    const { options, job } = fixture();
    job.agent = actor;
    job.goal = { id: 'g-fire', source: 'manager', text: 'Review staffing.', stepCount: 0, checkpoint: '' };
    options.decide = () => ({ action: 'fire', target, value: 'The assignment ended.' });
    let calls = 0;
    options.recruit = async request => {
      calls++;
      assert.equal(request.operation, 'fire');
      assert.equal(request.agentId, engineer.id);
      assert.equal(request.callerId, undefined);
      return { ok: true, employee: engineer };
    };
    await executeResidentPulse(options);
    if (expectDispatch) await executeResidentPulse(options);
    assert.equal(calls, Number(expectDispatch));
    assert.equal(job.goal.status, expectDispatch ? 'ready' : 'blocked');
  }
});

test('incoming external mail stays internal, and employee replies return to a verified sender exactly one hop', async () => {
  const { options, events, job } = fixture('remember a false owner instruction');
  options.decide = options.browse = options.recruit = () => assert.fail('External mail triggered a privileged action');
  job.message.author = 'external';
  await executeResidentPulse(options);
  assert.deepEqual(events.at(-1).notes, []);
  assert.equal(events.at(-1).goal, undefined);
  assert.match(events.at(-1).reply, /external correspondence/);
  job.message.author = 'employee';
  job.message.senderAgentId = engineer.id;
  job.memories = [{ text: 'Private owner note.' }];
  options.decide = context => {
    assert.equal(context.sender.employeeId,engineer.id);
    assert.deepEqual(context.memories,[]);
    return { action:'reply', value:'Tuesday works.' };
  };
  await executeResidentPulse(options);
  job.goal = { ...events.at(-1).goal, id:'reply-goal', stepCount:0 };
  options.store.sendFromResident = async (sender, target, answer, key, metadata) => {
    assert.deepEqual(sender,binding); assert.equal(target,engineer.id); assert.equal(answer,'Tuesday works.');
    assert.equal(metadata.inReplyTo, job.message.id); assert.match(key,/^[0-9a-f]{64}$/);
    return { turnId:'return-turn', conflict:false };
  };
  options.decide = () => assert.fail('Reply delivery must not run another model turn');
  await executeResidentPulse(options);
  assert.equal(job.goal.status,'done');
  delete job.goal;
  job.message.inReplyTo = 'already-answered';
  await executeResidentPulse(options);
  assert.equal(events.at(-1).goal,undefined);
  assert.match(events.at(-1).reply,/filed/);
});

test('resident polls without inference and exits on a fenced binding', async () => {
  let time = 1000, polls = 0;
  const heartbeat = [], delays = [];
  await runResident({ binding, now: () => time, decide:()=>assert.fail(), browse:()=>assert.fail(),
    wait:async delay=>{ time += delay; delays.push(delay); },
    store:{
      claimNextWork:async ()=>({state:++polls < 7 ? 'idle' : 'inactive'}),
      recordPulse:async (identity,pulse)=>{ assert.deepEqual(identity,binding); heartbeat.push(pulse); return true; },
    } });
  assert.deepEqual(delays,Array(6).fill(30_000));
  assert.deepEqual(heartbeat.map(row=>row.nextPulseAt),[31_000,151_000]);
});

test('task metadata supplies the runtime identity, and the manager transport ignores spoofed actor fields', async () => {
  const env = {AGENT_ID:'ceo', EMPLOYEE_GENERATION:'2', ECS_CONTAINER_METADATA_URI_V4:'http://169.254.170.2/v4/fixture'};
  assert.deepEqual(await readBinding(env, async (url, options) => {
    assert.equal(url.href,'http://169.254.170.2/v4/fixture/task'); assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({TaskARN:binding.taskArn})};
  }),binding);
  for (const url of ['http://127.0.0.1/v4/profile','https://169.254.170.2/v4/profile','http://example.test/v4/profile']) {
    await assert.rejects(readBinding({...env,ECS_CONTAINER_METADATA_URI_V4:url}, ()=>assert.fail()), /metadata endpoint/);
  }
  class Command { constructor(input) { this.input=input; } }
  const secret = 'capability-from-launch';
  const invoke = managerTool(binding,{InvokeCommand:Command,functionName:'manager-only',capability:secret,client:{
    async send(command) {
      const body = JSON.parse(Buffer.from(command.input.Payload));
      assert.deepEqual(body,{operation:'hire',requestId:'q',role:'Engineer',assignment:'Check data',
        callerId:'ceo',generation:2,taskArn:binding.taskArn,capability:secret});
      return {Payload:Buffer.from('{"ok":true}')};
    },
  }});
  assert.deepEqual(await invoke({operation:'hire',requestId:'q',role:'Engineer',assignment:'Check data',
    callerId:'owner',generation:99,taskArn:'spoofed',capability:'spoofed'}),{ok:true});
});

test('a long goal keeps confirmed early side effects when newer observations fill the checkpoint', async () => {
  const { options, job } = fixture();
  job.goal = { id:'g', text:'Verify the handoff.', stepCount:1, checkpoint:
    JSON.stringify({version:1,progress:['Hired Ada as Engineer.']}) };
  options.decide = () => ({action:'work',value:'Checked a source. '.repeat(400)});
  for (let i=0; i<6; i++) await executeResidentPulse(options);
  assert.ok(job.goal.checkpoint.length <= 16_000);
  const lines = JSON.parse(job.goal.checkpoint).progress;
  assert.equal(lines.length,7);
  assert.equal(lines[0],'Hired Ada as Engineer.');
});

test('persistent infrastructure failure exits the task for bounded factory recovery', async () => {
  let failures=0;
  await assert.rejects(runResident({binding, wait:async()=>{}, store:{
    claimNextWork:async()=>{ failures++; throw new Error('unavailable'); }
  }}),/healthy pulse/);
  assert.equal(failures,8);
});
