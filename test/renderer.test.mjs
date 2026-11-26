import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeBrowser } from '../src/browser.mjs';
import { listenPrivateSocket, listenServer } from '../src/private-socket.mjs';
import { listenRenderer, maxDocumentBytes, renderDocument } from '../src/renderer.mjs';

async function socketFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'co-render-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return join(dir, 'renderer.sock');
}

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function closeOnCompletion(t, server) {
  t.after(() => new Promise(resolve => server.close(resolve)));
}

function send(socketPath, { method = 'POST', path = '/render', type = 'text/plain', body = Buffer.from('report'), headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, agent: false, signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': type, 'Content-Length': body.length, ...headers },
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('Unix renderer receives only fetched bytes and MIME, then reads the document in real offline Chromium', async t => {
  const socket = await socketFixture(t);
  setEnv(t, 'PEROTTINO_BROWSER_RENDER_SOCKET', socket);
  // This checked-in fixture is the only document tested with an outer sandbox.
  setEnv(t, 'PEROTTINO_BROWSER_EXTERNAL_SANDBOX', '1');
  const html = '<title>Weekly report</title><h1>Verified content</h1><img src="/secondary"><script>fetch("/secondary")</script>';
  const paths = [];
  const upstream = http.createServer((req, res) => { paths.push(req.url); res.writeHead(200, { 'Content-Type': 'text/html' }).end(html); });
  await listenServer(upstream, 0, '127.0.0.1');
  closeOnCompletion(t, upstream);
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  let renders = 0;
  const server = await listenRenderer(socket, async (document, signal) => {
    renders++;
    assert.deepEqual(Object.keys(document).sort(), ['body', 'type']);
    assert.equal(document.type, 'text/html');
    assert.equal(document.body.toString(), html);
    return renderDocument(document, signal);
  });
  closeOnCompletion(t, server);
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  assert.equal((await send(socket, { method: 'GET', path: '/healthz', body: Buffer.alloc(0) })).status, 200);
  const url = origin + '/report?private-query-value';
  const browse = makeBrowser({ fixtureOrigin: origin });
  assert.deepEqual(await browse(url), { url, title: 'Weekly report', text: 'Verified content' });
  assert.deepEqual(paths, ['/report?private-query-value']);
  await assert.rejects(browse('http://169.254.169.254/'), /public web destinations/);
  assert.equal(renders, 1);
});

test('renderer bounds content, concurrency and response fields on its private socket', async t => {
  const socket = await socketFixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let activeCalls = 0;
  const server = await listenRenderer(socket, async ({ body }) => {
    activeCalls++;
    if (body.toString() === 'bad-output') return { title: 'x'.repeat(241), text: '' };
    started.resolve();
    await release.promise;
    return { title: '', text: 'ok', extraneous: 'excluded' };
  });
  closeOnCompletion(t, server);
  assert.equal((await send(socket, { type: 'image/png' })).status, 415);
  assert.equal((await send(socket, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await send(socket, { body: Buffer.alloc(0), headers: { 'Content-Length': String(maxDocumentBytes + 1) } })).status, 413);
  const first = send(socket);
  try {
    await started.promise;
    assert.equal((await send(socket)).status, 429);
  } finally { release.resolve(); }
  assert.deepEqual(JSON.parse((await first).body), { title: '', text: 'ok' });
  assert.equal((await send(socket, { body: Buffer.from('bad-output') })).status, 502);
  assert.equal(activeCalls, 2);
});

test('console bounds unauthenticated renderer responses and fails closed when the configured socket disappears', async t => {
  const socket = await socketFixture(t);
  setEnv(t, 'PEROTTINO_BROWSER_RENDER_SOCKET', socket);
  const upstream = http.createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end('report'));
  await listenServer(upstream, 0, '127.0.0.1');
  closeOnCompletion(t, upstream);
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.url, '/render');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(' '.repeat(65537));
  });
  await listenPrivateSocket(server, socket);
  const browse = makeBrowser({ fixtureOrigin: origin });
  try {
    await assert.rejects(browse(origin), /could not render/);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  await assert.rejects(browse(origin), /could not render/);
});
