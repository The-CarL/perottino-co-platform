import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localInteractiveBrowser } from '../src/interactive-browser.mjs';
import { once } from 'node:events';
import { interactiveResource, makeBrowser } from '../src/browser.mjs';

test('browser enforces URL and private-address boundaries before a request', async () => {
  const browse = makeBrowser();
  for (const url of ['file:///etc/passwd', 'data:text/html,hello', 'http://user:pw@example.com',
    'http://169.254.169.254/', 'http://127.0.0.1', 'http://2130706433/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[2002:7f00:1::]/', 'http://10.0.0.2/',
    'http://localhost/', 'http://service.internal/', 'http://example.com:8022/']) {
    await assert.rejects(browse(url), /public web destinations|Only HTTP/);
  }
});

test('real Chromium reads the approved document, blocks subresources, and handles redirects and request limits', async t => {
  // This fixture is checked-in markup. CI containers commonly prohibit Chromium user
  // namespaces. Limit the override to this test process and this document.
  const oldSandbox = process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;
  process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX = '1';
  t.after(() => {
    if (oldSandbox === undefined) delete process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;
    else process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX = oldSandbox;
  });
  let secondaryRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        '<title>Field report</title><h1>Published figures</h1><img src="/tracking">' +
        '<script>document.body.innerText="ran script";fetch("/tracking")</script><iframe src="/tracking"></iframe>');
    } else if (req.url === '/relative') {
      res.writeHead(302, { location: '/page' }).end();
    } else if (req.url === '/private') {
      res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    } else if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('a'.repeat(1_100_000));
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else { secondaryRequests++; res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browse = makeBrowser({ fixtureOrigin: origin });
  await assert.rejects(makeBrowser()(origin + '/page'), /public web destinations/);
  await assert.rejects(browse(origin + '/private'), /public web destinations/);
  await assert.rejects(browse(origin + '/large'), /size limit/);
  await assert.rejects(browse(origin + '/loop'), /Too many redirects/);
  const page = await browse(origin + '/relative');
  assert.equal(page.url, origin + '/page');
  assert.equal(page.title, 'Field report');
  assert.match(page.text, /Published figures/);
  assert.doesNotMatch(page.text, /ran script/);
  assert.equal(secondaryRequests, 0);
});

test('authenticated login redirects retain cookies on the same origin and require an explicit click', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'interactive-login-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const certPath = join(dir, 'cert.pem'), keyPath = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const cert = await readFile(certPath, 'utf8');
  const trusted = tls.getCACertificates();
  tls.setDefaultCACertificates([...trusted, cert]);
  t.after(() => tls.setDefaultCACertificates(trusted));
  let protectedRequests = 0;
  const server = https.createServer({ cert, key: await readFile(keyPath) }, (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<form method=post action=/login><button>Sign in</button></form>');
      return;
    }
    if (req.url === '/invalid') {
      res.writeHead(302, { location: 'https://' }).end();
      return;
    }
    if (req.url === '/protected') {
      protectedRequests++;
      const authorized = req.headers.cookie === 'session=fixture';
      res.writeHead(authorized ? 200 : 401, { 'content-type': 'text/plain' }).end(authorized ? 'Signed in' : 'Signed out');
      return;
    }
    const redirect = () => res.writeHead(303, {
      location: req.url === '/external' ? 'https://other.example/continue' : '/protected',
      'set-cookie': 'session=fixture; Path=/; HttpOnly; Secure; SameSite=Strict',
    }).end();
    if (req.method === 'POST') setTimeout(redirect, 250);
    else redirect();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'https://127.0.0.1:' + server.address().port;
  const request = (path, origins) => interactiveResource({ raw: origin + path, method: 'GET', origins, fixtureOrigin: origin });
  assert.equal((await request('/login')).headers['set-cookie'], undefined);
  assert.equal((await request('/external', [origin])).headers['set-cookie'], undefined);
  await assert.rejects(request('/invalid', [origin]), /Invalid URL/);

  const oldSandbox = process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;
  process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX = '1';
  t.after(() => {
    if (oldSandbox === undefined) delete process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;
    else process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX = oldSandbox;
  });
  const browser = localInteractiveBrowser({dataDir: dir, fixtureOrigin: origin});
  t.after(() => browser.close());
  const session = 'login-form';
  await browser.start({id: session, profileId: 'synthetic', expiresAt: Date.now() + 30_000});
  const action = (name, input = {}) => browser.action(session, 'browser.' + name, input, [origin]);
  await action('navigate', {url: origin + '/'});
  await action('input', {kind: 'key', key: 'Tab'});
  await action('input', {kind: 'key', key: 'Enter'});
  const interstitial = await action('read');
  assert.equal(interstitial.url, origin + '/login');
  assert.equal(interstitial.text, 'Continue to redirected page');
  assert.equal(protectedRequests, 0);
  await action('input', {kind: 'click', x: 30, y: 15});
  assert.equal((await action('read')).text, 'Signed in');
  assert.equal(protectedRequests, 1);
});
