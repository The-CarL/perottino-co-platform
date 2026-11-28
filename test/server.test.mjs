import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { hashPassword } from '../src/auth.mjs';

const username = 'owner';
const password = 'local-owner-test-password';
const passwordHash = await hashPassword(password);
const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

function useDefaultHeadcount(t) {
  const configured = process.env.PEROTTINO_EMPLOYEE_LIMIT;
  if (configured === undefined) return;
  delete process.env.PEROTTINO_EMPLOYEE_LIMIT;
  t.after(() => { process.env.PEROTTINO_EMPLOYEE_LIMIT = configured; });
}

async function directory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'perottino-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function open(dataDir, runner, options = {}) {
  const app = createApp({ dataDir, username, passwordHash, foundations: false, runner, browser: async () => ({}), ...options });
  return listen(app);
}

async function listen(app) {
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const get = (route, headers = { Authorization: auth }) => fetch(origin + route, { headers });
  const post = (requestId, text) => fetch(origin + '/api/agents/ceo/messages', {
    method: 'POST', headers: { Authorization: auth, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, text })
  });
  const change = (id, method, body) => fetch(origin + '/api/agents/ceo/memory/' + id, {
    method, headers: { Authorization: auth, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const company = async (op, input = {}) => {
    const response = await fetch(origin + '/api/company/' + op, { method: 'POST',
      headers: { Authorization: auth, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, 200, op + ': ' + JSON.stringify(result));
    return result;
  };
  return { ...app, get, post, change, company };
}

async function until(operation) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await wait(20);
  }
  throw new Error('Timed out waiting for the worker.');
}

const messagesPath = '/api/agents/ceo/messages';
const memoryPath = '/api/agents/ceo/memory';

test('console protects private routes and serves Mara from the directory', async t => {
  const app = await open(await directory(t), async () => 'OK');
  try {
    assert.equal((await app.get('/healthz', {})).status, 200);
    for (const path of ['/', '/chat.js', '/api/directory', messagesPath, memoryPath])
      assert.equal((await app.get(path, {})).status, 401);
    assert.equal((await app.get('/')).status, 200);
    assert.equal((await app.get('/.local/owner.json')).status, 404);
    assert.equal((await app.get('/api/agents/missing/messages')).status, 404);
    assert.deepEqual(await (await app.get('/api/directory')).json(), {
      agents: [{ id: 'ceo', name: 'Mara', handle: 'mara', role: 'CEO' }], mode: process.env.PEROTTINO_AGENT_MODE || 'local'
    });
    assert.equal((await app.post('empty', '  ')).status, 400);
  } finally { await app.close(); }
});

test('same-agent turns serialize, deduplicate requests, retain history and commit memory with the reply', async t => {
  const dataDir = await directory(t);
  const seen = [];
  const first = Promise.withResolvers();
  const started = Promise.withResolvers();
  const app = await open(dataDir, async ({ message, history, remember, recall }) => {
    seen.push(message.text);
    if (message.text === 'first') {
      assert.deepEqual(history, []);
      remember('A durable fact');
      assert.equal(recall('durable')[0].sourceMessageId, message.id);
      started.resolve();
      await first.promise;
    } else {
      assert.deepEqual(history.map(item => item.text), ['first', 'reply to first']);
      assert.equal(recall('Durable').length, 1);
      remember('A durable fact');
    }
    return 'reply to ' + message.text;
  });
  try {
    const firstPost = await app.post('page-send-1', 'first');
    assert.equal(firstPost.status, 202);
    const firstId = (await firstPost.json()).message.id;
    await started.promise;
    const dup = await app.post('page-send-1', 'first');
    assert.equal((await dup.json()).message.id, firstId);
    assert.equal((await app.post('page-send-1', 'other')).status, 409);
    assert.equal((await app.post('page-send-2', 'second')).status, 202);
    assert.equal((await (await app.get(messagesPath)).json()).status, 'working');
    assert.deepEqual(await (await app.get(memoryPath)).json(), { memories: [] });
    assert.deepEqual(seen, ['first']);
    first.resolve();
    const transcript = await until(async () => {
      const state = await (await app.get(messagesPath)).json();
      return state.status === 'idle' && state;
    });
    assert.deepEqual(transcript.messages.map(item => item.text), ['first', 'reply to first', 'second', 'reply to second']);
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal((await (await app.get(memoryPath)).json()).memories[0].sourceMessageId, firstId);
    await app.close();

    const restarted = await open(dataDir, async () => { throw Error('Unexpected turn'); });
    try {
      assert.deepEqual(await (await restarted.get(messagesPath)).json(), transcript);
      assert.equal((await (await restarted.get(memoryPath)).json()).memories.length, 1);
    } finally { await restarted.close(); }
  } finally { first.resolve(); await app.close(); }
});

test('expired attempt is reclaimed after reopen and stale writes cannot commit', async t => {
  const dataDir = await directory(t);
  const first = createStore(dataDir);
  first.enqueue('ceo', 'Check the plan', 'request-1');
  const stale = first.claim(10);
  first.close();
  await wait(20);
  const second = createStore(dataDir);
  try {
    const current = second.claim(10000);
    assert.equal(current.message.id, stale.message.id);
    assert.notEqual(current.token, stale.token);
    assert.equal(second.complete(stale, 'obsolete', []), false);
    second.release(stale);
    second.fail(stale);
    assert.equal(second.complete(current, 'recovered', []), true);
    assert.equal(second.complete(current, 'duplicate', []), false);
    assert.deepEqual(second.messages('ceo').messages.map(item => item.text), ['Check the plan', 'recovered']);
  } finally { second.close(); }
});

test('timed-out turns discard staged memory and release the next assignment', async t => {
  const app = await open(await directory(t), async ({ message, remember }) => {
    if (message.text === 'slow') {
      remember('unfinished');
      await new Promise(() => {});
    }
    return 'done';
  }, { turnTimeoutMs: 100 });
  try {
    assert.equal((await app.post('test-timeout', 'slow')).status, 202);
    await until(async () => (await (await app.get(messagesPath)).json()).status === 'error');
    assert.deepEqual(await (await app.get(memoryPath)).json(), { memories: [] });
    assert.equal((await app.post('test-next', 'next')).status, 202);
    await until(async () => (await (await app.get(messagesPath)).json()).status === 'idle');
    assert.equal((await (await app.get(messagesPath)).json()).messages.at(-1).text, 'done');
  } finally { await app.close(); }
});

test('owner memory corrections and forget preserve provenance and replay safely after further changes', async t => {
  const oldSnapshot = Promise.withResolvers();
  const allowReply = Promise.withResolvers();
  const app = await open(await directory(t), async ({ message, remember, recall }) => {
    if (message.text === 'note') { remember('pending review'); return 'saved'; }
    const snapshot = recall();
    if (snapshot[0]?.text === 'pending review') {
      oldSnapshot.resolve();
      await allowReply.promise;
    }
    return snapshot[0]?.text || 'no saved notes';
  });
  try {
    const sent = (await (await app.post('one', 'note')).json()).message;
    const note = await until(async () => (await (await app.get(memoryPath)).json()).memories[0]);
    await app.post('two', 'recall');
    await oldSnapshot.promise;
    const correction = { requestId: 'fix', text: 'review completed' };
    assert.equal((await app.change(note.id, 'PATCH', correction)).status, 200);
    assert.equal((await app.change(note.id, 'PATCH', { ...correction, text: 'different' })).status, 409);
    const [corrected] = (await (await app.get(memoryPath)).json()).memories;
    assert.equal(corrected.text, 'review completed');
    assert.equal(corrected.sourceMessageId, sent.id);
    assert.equal(corrected.updatedBy, 'owner');
    allowReply.resolve();
    const transcript = await until(async () => {
      const batch = await (await app.get(messagesPath)).json();
      return batch.status === 'idle' && batch.messages;
    });
    assert.equal(transcript.at(-1).text, 'review completed');
    assert.equal((await app.change(note.id, 'DELETE', { requestId: 'forget' })).status, 200);
    assert.equal((await app.change(note.id, 'DELETE', { requestId: 'forget' })).status, 200);
    assert.equal((await app.change(note.id, 'PATCH', correction)).status, 200);
    assert.deepEqual((await (await app.get(memoryPath)).json()).memories, []);
  } finally { allowReply.resolve(); await app.close(); }
});

test('local manager hires once, paused employees keep durable goals across restart, and firing preserves the archive', async t => {
  useDefaultHeadcount(t);
  const dir = await directory(t);
  let app = await open(dir);
  t.after(() => app.close());
  const call = async (agentId, path, data) => {
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    return fetch(origin + '/api/agents/' + agentId + '/' + path, {method: data ? 'POST' : 'GET',
      headers:{Authorization:auth, Origin:origin, 'Content-Type':'application/json'}, body: data && JSON.stringify(data)});
  };
  const act = (id, op, requestId) => call(id,'lifecycle/' + op,{requestId});
  const goal = {requestId:'goal-qa',text:'remember Check the release notes'};
  const profile = async id => (await call(id,'employee')).json();
  assert.equal((await profile('ceo')).employee.canHire, true);
  assert.equal((await act('ceo','hire','forged')).status, 404);
  const firstAssignment = 'recall release';
  await app.post('hire-request','hire Engineer\n' + firstAssignment);
  await app.post('hire-request','hire Engineer\n' + firstAssignment);
  const employee = await until(async () => {
    const { agents } = await (await app.get('/api/directory')).json();
    assert.ok(agents.length <= 2);
    return agents.find(agent => agent.role === 'Engineer');
  });
  const id = employee.id;
  assert.equal((await profile(id)).employee.managerId, 'ceo');
  assert.equal((await profile(id)).employee.canHire, false);
  await until(async () => (await profile(id)).goals.find(g => g.text === firstAssignment && g.status === 'done'));
  const assigned = (await (await call(id,'messages')).json()).messages.find(m => m.text === firstAssignment);
  assert.equal(assigned.author,'employee');
  assert.equal(assigned.senderAgentId,'ceo');
  await app.post('second-hire','hire Writer');
  await until(async () => (await (await app.get('/api/directory')).json()).agents.some(agent => agent.role === 'Writer'));
  await call(id,'messages',{requestId:'forbidden',text:'hire QA'});
  await until(async () => (await (await call(id,'messages')).json()).messages.some(m => m.text.includes('do not have hiring authority')));
  assert.equal((await (await app.get('/api/directory')).json()).agents.length, 3);
  const paused = await (await act(id,'pause','pause-1')).json();
  assert.equal(paused.employee.desiredState, 'paused');
  assert.deepEqual(await (await act(id,'pause','pause-1')).json(), paused);
  assert.equal((await act(id,'resume','pause-1')).status, 409);
  const created = await (await call(id,'goals',goal)).json();
  assert.equal(created.goal.status, 'ready');
  const goalId = created.goal.id;
  await app.close();
  app = await open(dir);
  assert.equal((await profile(id)).employee.desiredState, 'paused');
  const queued = (await profile(id)).goals;
  assert.equal(queued.length, 2);
  assert.equal(queued[0].id, goalId);
  assert.equal(queued[0].status, 'ready');
  assert.equal((await act(id,'resume','resume-1')).status, 200);
  const done = await until(async () => {
    const rows = (await profile(id)).goals;
    return rows.find(g => g.id === goalId && g.status === 'done');
  });
  assert.equal(done.stepCount, 1);
  assert.match(done.checkpoint,/Check the release notes/);
  const memo = (await (await call(id,'memory')).json()).memories[0];
  assert.equal((await (await call(id,'messages/' + memo.sourceMessageId)).json()).message.text, goal.text);
  await call(id,'goals',{requestId:'general',text:'Design the new product'});
  await until(async () => (await profile(id)).goals.some(g => g.status === 'blocked' && g.checkpoint.includes('hosted decision worker')));
  assert.equal((await (await act(id,'fire','fire-1')).json()).employee.desiredState, 'fired');
  assert.equal((await act(id,'resume','resume-after-fire')).status, 409);
  assert.equal((await call(id,'goals',{requestId:'after',text:'New goal'})).status, 409);
  assert.equal((await call(id,'messages',{requestId:'after',text:'New message'})).status, 409);
  assert.equal((await (await call(id,'goals',goal)).json()).goal.id, goalId);
  assert.equal((await profile(id)).goals.length, 3);
  assert.equal((await (await call(id,'memory')).json()).memories[0].id, memo.id);
});

for (const [description, cap, options] of [
  ['the default of 100 employees', 100, undefined],
  ['a configured limit of two employees', 2, {employeeLimit:2}]
]) {
  test('local hiring enforces ' + description + ', including the CEO and paused staff', async t => {
    if (options === undefined) useDefaultHeadcount(t);
    const store = createStore(await directory(t), options);
    try {
      const nextTurn = requestId => {
        store.enqueue('ceo','hire Engineer',requestId);
        return store.claim(10000);
      };
      let report;
      for (let seat = 2; seat <= cap; seat++) {
        const job = nextTurn('seat-' + seat);
        report = store.hireForTurn(job,'Engineer');
        if (seat === cap) assert.equal(store.hireForTurn(job,'Engineer').id, report.id);
        assert.equal(store.complete(job,'Hired',[]), true);
      }
      assert.equal(store.directory().length, cap);
      const control = operation => store.setEmployeeState({agentId:report.id, operation, requestId:operation});
      assert.equal(control('pause').employee.desiredState,'paused');
      const next = nextTurn('one-more');
      assert.throws(() => store.hireForTurn(next,'Engineer'), {code:'EMPLOYEE_LIMIT'});
      assert.equal(store.directory().length, cap);
      assert.equal(control('fire').employee.desiredState,'fired');
      const replacement = store.hireForTurn(next,'Engineer');
      assert.notEqual(replacement.id,report.id);
      assert.equal(store.complete(next,'Hired',[]), true);
      const working = store.directory().filter(agent => store.employee(agent.id).desiredState === 'active');
      assert.equal(working.length, cap);
    } finally { store.close(); }
  });
}

test('default local company hires from a CEO conversation and resumes the same employee inbox after reopening', async t => {
  const dataDir = await directory(t);
  const start = () => listen(createApp({ dataDir, username, passwordHash }));
  let app = await start();
  t.after(() => app.close());
  const { conversation } = await app.company('conversations.dm', { peerId: 'ceo' });
  const post = { conversationId: conversation.id, requestId: 'hire-a-designer', text: 'hire Designer' };
  const first = await app.company('messages.post', post);
  assert.equal((await app.company('messages.post', post)).message.id, first.message.id);
  await until(async () => {
    const { messages } = await app.company('messages.list', { conversationId: conversation.id });
    return messages.some(m => m.senderId === 'ceo' && m.replyTo === first.message.id && /Designer/.test(m.text));
  });
  const { agents } = await app.company('directory');
  assert.equal(agents.length, 2);
  const designer = agents.find(person => person.role === 'Designer');
  assert.equal(designer.managerId, 'ceo');
  assert.equal(designer.canHire, false);
  await app.company('employee.pause', { agentId: designer.id, requestId: 'pause-designer' });
  const dm = (await app.company('conversations.dm', { peerId: designer.id })).conversation;
  const message = (await app.company('messages.post', { conversationId: dm.id, requestId: 'design-first', text: 'hello' })).message;
  await app.close();
  app = await start();
  assert.equal((await app.company('directory')).agents.find(p => p.id === designer.id).desiredState, 'paused');
  assert.equal((await app.company('messages.list', { conversationId: dm.id })).messages.length, 1);
  await app.company('employee.resume', { agentId: designer.id, requestId: 'resume-designer' });
  await until(async () => (await app.company('messages.list', { conversationId: dm.id })).messages
    .some(m => m.replyTo === message.id && m.senderId === designer.id));
  await app.company('employee.fire', { agentId: designer.id, requestId: 'fire-designer' });
  assert.equal((await app.company('directory')).agents.find(p => p.id === designer.id).desiredState, 'fired');
  assert.equal((await app.company('messages.list', { conversationId: dm.id })).messages.length, 2);
  const ownerHire = { requestId: 'owner-hire', role: 'QA' };
  const report = (await app.company('employee.hire', ownerHire)).employee;
  assert.equal(report.managerId, 'ceo');
  assert.equal(report.canHire, false);
  assert.equal((await app.company('employee.hire', ownerHire)).employee.id, report.id);
  assert.equal((await app.company('directory')).agents.length, 3);
});
