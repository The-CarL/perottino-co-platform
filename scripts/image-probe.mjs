// Streamed by check-image.mjs to a fresh container's Node executable.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const phase = process.argv[2];
assert.notEqual(process.getuid(), 0, 'the production image must run unprivileged');
const note = 'The first release uses a signed handoff.';

async function waitFor(check) {
  let lastError;
  for (let i = 0; i < 60; i++) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error('Timed out waiting for ' + phase + ' image probe', {cause:lastError});
}
async function checkWorker() {
  const call = authorization => new Promise((resolve, reject) => {
    const req = request({ socketPath:process.env.PEROTTINO_BEDROCK_WORKER_SOCKET, path:'/decision',
      method:'POST', headers:{'Content-Type':'application/json',Authorization:authorization} }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error',reject);
    req.end('{}');
  });
  await waitFor(async () => (await call('')) === 401);
  // A malformed request verifies the authenticated socket path without invoking a model.
  assert.equal(await call('Bearer ' + process.env.PEROTTINO_BEDROCK_WORKER_TOKEN),400);
}
async function checkRenderer() {
  assert.equal(process.env.OWNER_PASSWORD_HASH,undefined);
  assert.equal(process.env.PEROTTINO_BEDROCK_WORKER_TOKEN,undefined);
  assert.deepEqual(Object.keys(networkInterfaces()),['lo']);
  await waitFor(() => new Promise((resolve, reject) => {
    const req = request({socketPath:process.env.PEROTTINO_BROWSER_RENDER_SOCKET,path:'/healthz'}, res => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error',reject);
    req.end();
  }));
}
async function checkBrowser() {
  assert.ok(process.env.PEROTTINO_BROWSER_RENDER_SOCKET);
  assert.equal(process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX,undefined);
  const fixture = createServer((_req,res) => res.writeHead(200,{'content-type':'text/html'})
    .end('<title>Image smoke fixture</title><main>The browser can render.</main>'));
  await new Promise(r => fixture.listen(0,'127.0.0.1',r));
  try {
    const origin = 'http://127.0.0.1:' + fixture.address().port;
    const { browse } = await import(pathToFileURL(resolve('src/browser.mjs')));
    const result = await browse(origin + '/', {fixtureOrigin:origin});
    assert.equal(result.title,'Image smoke fixture');
    assert.match(result.text,/The browser can render\./);
  } finally { await new Promise(r => fixture.close(r)); }
}
async function checkApp() {
  const base = 'http://127.0.0.1:3000';
  await waitFor(async () => (await fetch(base + '/healthz')).ok);
  assert.equal((await fetch(base + '/chat')).status,403);
  const ingress = {'X-Forwarded-Proto':'https'};
  const challenge = await fetch(base + '/chat',{headers:ingress});
  assert.equal(challenge.status,401);
  assert.match(challenge.headers.get('www-authenticate'),/^Basic /);
  const auth = {...ingress, Authorization:'Basic ' +
    Buffer.from(process.env.OWNER_USERNAME + ':' + process.env.IMAGE_SMOKE_PASSWORD).toString('base64')};
  const read = async path => {
    const response = await fetch(base + path,{headers:auth});
    assert.equal(response.status,200);
    return response;
  };
  const directory = await (await read('/api/directory')).json();
  assert.equal(directory.mode,'local');
  assert.ok(directory.agents.some(agent => agent.id === 'ceo'));
  const endpoint = '/api/agents/ceo/messages';
  if (phase === 'write') {
    assert.match(await (await read('/chat')).text(),/Company chat/);
    for (const asset of ['/chat.css','/chat.js']) await read(asset);
    const sent = await fetch(base + endpoint,{method:'POST',headers:{...auth,
      'Content-Type':'application/json', 'X-Requested-With':'owner-console'},
      body:JSON.stringify({requestId:'image-smoke-turn',text:'remember ' + note})});
    assert.equal(sent.status,202);
    await checkBrowser();
  }
  await waitFor(async () => {
    const {messages,status} = await (await read(endpoint)).json();
    return status === 'idle' && messages.length === 2 && messages[0].author === 'owner'
      && messages[1].author === 'agent';
  });
  const {memories} = await (await read('/api/agents/ceo/memory')).json();
  assert.equal(memories.length,1);
  assert.equal(memories[0].text,note);
  const {messages} = await (await read(endpoint)).json();
  assert.equal(memories[0].sourceMessageId,messages[0].id);
}
if (phase === 'renderer') await checkRenderer();
else if (phase === 'worker') await checkWorker();
else if (phase === 'write' || phase === 'recover') await checkApp();
else throw new Error('Unknown image probe phase');
