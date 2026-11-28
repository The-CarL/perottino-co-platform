import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import http from 'node:http';
import { browserControl, makeAgentCoreBrowser } from '../src/agentcore-browser.mjs';

test('AgentCore control uses AWS commands, an idempotent short session, and signed CDP limited to the AWS endpoint', async () => {
  const commands = [];
  const client = {
    config: { credentials: async () => ({ accessKeyId: 'SYNTHETIC_TEST_KEY', secretAccessKey: 'synthetic-for-local-signing-only',
      sessionToken: 'synthetic-session' }) },
    async send(command, options) { commands.push({ type: command.constructor.name, input: command.input, options });
      return { sessionId: 'session123' }; },
    destroy() { commands.push({ type: 'destroy' }); },
  };
  const control = await browserControl('us-east-1', 'aws.browser.v1', { client, connectCDP: async (url, options) => {
    assert.equal(url, 'wss://bedrock-agentcore.us-east-1.amazonaws.com/browser-streams/aws.browser.v1/sessions/session123/automation');
    assert.match(options.headers.authorization, /us-east-1\/bedrock-agentcore\/aws4_request/);
    assert.equal(options.headers['x-amz-security-token'], 'synthetic-session');
    return 'connected';
  } });
  const id = await control.start(new AbortController().signal);
  assert.equal(await control.connect(id), 'connected');
  await control.stop(id);
  control.close();
  assert.deepEqual(commands.map(x => x.type), ['StartBrowserSessionCommand', 'StopBrowserSessionCommand', 'destroy']);
  const start = commands[0].input;
  assert.equal(start.browserIdentifier, 'aws.browser.v1');
  assert.equal(start.sessionTimeoutSeconds, 90);
  assert.match(start.clientToken, /^[0-9a-f-]{36}$/);
  assert.equal(start.profileConfiguration, undefined);
  assert.equal(commands[1].input.sessionId, id);
  assert.ok(commands[1].options.abortSignal);
});

test('cloud browser starts on demand, isolates the public reader and closes sessions after success or failure', async t => {
  const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Sample</h1>'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const fixtureOrigin = 'http://127.0.0.1:' + server.address().port;
  for (const failsAt of [undefined, 'connect', 'read', 'stop']) {
    const events = [];
    const control = async (region, id) => {
      assert.equal(region, 'us-east-1'); assert.equal(id, 'aws.browser.v1');
      return {
        async start(signal) { signal.throwIfAborted(); events.push('start'); return 's123'; },
        async connect(id) { assert.equal(id, 's123'); events.push('connect');
          if (failsAt === 'connect') throw new Error('connection failed');
          return { async close() { events.push('disconnect'); } }; },
        async stop(id) { assert.equal(id, 's123'); events.push('stop'); if (failsAt === 'stop') throw new Error('stop failed'); },
        close() { events.push('destroy'); },
      };
    };
    const read = async (_browser, doc) => {
      events.push('read'); assert.equal(doc.type, 'text/html'); assert.equal(doc.body.toString(), '<h1>Sample</h1>');
      if (failsAt === 'read') throw new Error('render failure');
      return { title: 'Sample', text: 'Hello' };
    };
    const browse = makeAgentCoreBrowser({ fixtureOrigin, control, read, region: 'us-east-1', browserIdentifier: 'aws.browser.v1' });
    await assert.rejects(browse('http://169.254.169.254'), /public web destinations/);
    assert.deepEqual(events, []);
    if (failsAt) await assert.rejects(browse(fixtureOrigin + '/page'), { code: 'BROWSER_RENDER_FAILED' });
    else assert.deepEqual(await browse(fixtureOrigin + '/page'), { url: fixtureOrigin + '/page', title: 'Sample', text: 'Hello' });
    assert.deepEqual(events, failsAt === 'connect'
      ? ['start', 'connect', 'stop', 'destroy'] : ['start', 'connect', 'read', 'disconnect', 'stop', 'destroy']);
  }
});
