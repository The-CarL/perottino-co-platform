import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { startBedrockRelay } from '../src/bedrock-relay.mjs';

const region = 'us-east-1';
const hostname = 'bedrock-runtime.us-east-1.amazonaws.com';
const path = '/openai/v1/responses';
// The transport validates the destination and the native scope. The service
// authenticates the signature, as covered by the independent wire test.
const authorization = 'AWS4-HMAC-SHA256 Credential=AKIAFAKE/20261127/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=' + 'a'.repeat(64);

function post(relay, { target = path, host = hostname, method = 'POST', auth = authorization } = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(relay.baseUrl);
    const req = request({ hostname: base.hostname, port: base.port, path: target, method,
      headers: { host, authorization: auth, 'content-type': 'application/json', 'content-length': 2 } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
    req.on('error', reject);
    req.end('{}');
  });
}

function localTransport(server) {
  return (options, receive) => request({ ...options, protocol: 'http:', hostname: '127.0.0.1',
    port: server.address().port, agent: false }, receive);
}

test('relay rejects other hosts, routes, methods, and credential scopes without contacting an upstream', async t => {
  let contacted = 0;
  const stop = new AbortController();
  const relay = await startBedrockRelay(region, stop.signal, () => { contacted++; throw new Error('Unexpected upstream call'); });
  t.after(() => relay.close());
  for (const invalid of [
    { host: 'other.example' }, { host: '127.0.0.1' }, { target: '/' }, { target: path + '?query=1' },
    { target: 'https://other.example/openai/v1/responses' }, { method: 'PUT' }, { auth: '' },
    { auth: authorization.replace('/us-east-1/', '/us-west-2/') },
  ]) {
    const result = await post(relay, invalid);
    assert.ok(result.status >= 400, 'Relay should reject the request');
  }
  assert.equal(contacted, 0);
});

test('relay refuses upstream redirects and prevents a second inference on the same listener', async t => {
  let calls = 0;
  const upstream = createServer((_req, res) => { calls++; res.writeHead(307, { Location: 'https://other.example/' }).end(); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const stop = new AbortController();
  const relay = await startBedrockRelay(region, stop.signal, localTransport(upstream));
  t.after(() => relay.close());
  const result = await post(relay);
  assert.ok(result.status >= 400);
  assert.equal(result.headers.location, undefined);
  // Implementations may close the listener immediately or reject the reused request.
  const second = await post(relay).catch(() => null);
  if (second) assert.ok(second.status >= 400);
  assert.equal(calls, 1);
});

test('aborting a decision closes its active upstream request and its loopback listener', { timeout: 7000 }, async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const upstream = createServer((_req, res) => { entered({ closed: once(res, 'close') }); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const stop = new AbortController();
  const relay = await startBedrockRelay(region, stop.signal, localTransport(upstream));
  t.after(() => relay.close());
  const pending = post(relay).catch(() => null);
  const { closed } = await started;
  stop.abort();
  await closed;
  await pending;
  await relay.close();
  await assert.rejects(post(relay), /ECONNREFUSED|socket hang up/);
});
