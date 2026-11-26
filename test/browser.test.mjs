import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { makeBrowser } from '../src/browser.mjs';

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
  const oldBinary = process.env.PEROTTINO_CHROMIUM_PATH;
  process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX = '1';
  if (!oldBinary && existsSync('/usr/bin/chromium')) process.env.PEROTTINO_CHROMIUM_PATH = '/usr/bin/chromium';
  t.after(() => {
    if (oldSandbox === undefined) delete process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;
    else process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX = oldSandbox;
    if (oldBinary === undefined) delete process.env.PEROTTINO_CHROMIUM_PATH;
    else process.env.PEROTTINO_CHROMIUM_PATH = oldBinary;
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
