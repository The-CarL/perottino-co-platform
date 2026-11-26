import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const maxBytes = 1_048_576;
const deadlineMs = 30_000;
const deniedIPv4 = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) deniedIPv4.addSubnet(ip, prefix, 'ipv4');

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const deniedIPv6 = new BlockList();
for (const [ip, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) deniedIPv6.addSubnet(ip, prefix, 'ipv6');

function publicAddress(address) {
  if (isIP(address) === 4) return !deniedIPv4.check(address, 'ipv4');
  return isIP(address) === 6 && globalIPv6.check(address, 'ipv6') &&
    !deniedIPv6.check(address, 'ipv6');
}

function validatedUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Invalid page URL.');
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP or HTTPS pages without embedded credentials are supported.');
  }
  return url;
}

function beforeAbort(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolveAddress(url, signal, fixtureOrigin) {
  const name = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // The test-only exception is one literal loopback origin including its ephemeral port.
  if (fixtureOrigin && url.origin === fixtureOrigin && ['127.0.0.1', '::1'].includes(name)) {
    return name;
  }
  if ((url.port && !['80', '443'].includes(url.port)) ||
      (!isIP(name) && (!name.includes('.') || /(?:^|\.)(localhost|local|internal|home\.arpa)$/.test(name)))) {
    throw new Error('Browsing is limited to public web destinations.');
  }
  const answers = isIP(name) ? [{ address: name }] :
    await beforeAbort(lookup(name, { all: true, verbatim: true }), signal);
  if (!answers.length || answers.some(({ address }) => !publicAddress(address))) {
    throw new Error('Browsing is limited to public web destinations.');
  }
  return answers.find(({address}) => isIP(address) === 4)?.address ?? answers[0].address;
}

// The configured proxy sees only a validated numeric CONNECT target. DNS rebinding cannot
// change the target at the proxy. Origin TLS still verifies the requested public hostname.
async function proxyConnection(proxyValue, url, address, signal) {
  const proxy = new URL(proxyValue);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Invalid outbound proxy.');
  const port = url.port || (url.protocol === 'https:' ? 443 : 80);
  const authority = (isIP(address) === 6 ? '[' + address + ']' : address) + ':' + port;
  const headers = { Host: authority };
  if (proxy.username || proxy.password) {
    const credentials = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password);
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(credentials).toString('base64');
  }
  const socket = await new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? https : http).request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || undefined,
      method: 'CONNECT', path: authority, headers, agent: false, signal,
    });
    request.on('error', reject);
    request.on('connect', (response, connection, head) => {
      if (response.statusCode !== 200 || head.length) {
        connection.destroy();
        reject(new Error('Outbound proxy refused the page.')); return;
      }
      resolve(connection);
    });
    request.end();
  });
  // Agent owns the already connected socket; no further DNS or proxy credential is involved.
  const secure = url.protocol === 'https:';
  const agent = secure ? new https.Agent() : new http.Agent();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  agent.createConnection = () => secure ? tls.connect({
    socket, host: hostname, ...(isIP(hostname) ? {} : { servername: hostname }),
  }) : socket;
  return agent;
}

async function fetchDocument(url, address, signal, useProxy) {
  const secure = url.protocol === 'https:';
  const proxy = useProxy && (process.env.PEROTTINO_BROWSER_PROXY_URL ||
    (secure ? process.env.HTTPS_PROXY || process.env.HTTP_PROXY : process.env.HTTP_PROXY));
  const agent = proxy ? await proxyConnection(proxy, url, address, signal) : false;
  // Pin the socket to the validated DNS result. TLS and the Host header still authenticate the origin.
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      hostname: address, port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search, method: 'GET', agent, signal,
      ...(secure && !isIP(url.hostname.replace(/^\[|\]$/g, '')) ? { servername: url.hostname } : {}),
      headers: { Host: url.host, Accept: 'text/html, text/plain', 'Accept-Encoding': 'identity',
        'User-Agent': 'Perottino-Reader/1.0' },
    }, res => {
      res.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        resolve({ redirect: res.headers.location }); res.destroy(); return;
      }
      const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (res.statusCode < 200 || res.statusCode >= 300 || !['text/html', 'text/plain'].includes(type) ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        reject(new Error('This page did not return a readable HTML or text document.')); res.destroy(); return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('Page exceeds the browser size limit.')); res.destroy(); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
      res.on('aborted', () => reject(new Error('Page download interrupted.')));
    });
    req.on('error', reject);
    req.end();
  });
}

// Render the fetched document in a fresh, offline browser. The remote page never receives
// credentials, opens subresources, executes scripts, or gets a socket into the worker's network.
async function render(document, signal) {
  const { chromium } = await import('playwright-core');
  const home = await mkdtemp(path.join(tmpdir(), 'perottino-browser-'));
  let browser;
  let abort;
  try {
    signal.throwIfAborted();
    browser = await chromium.launch({
      executablePath: process.env.PEROTTINO_CHROMIUM_PATH || undefined,
      chromiumSandbox: process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX !== '1',
      env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: home },
      timeout: 15_000,
      args: ['--disable-background-networking', '--disable-dev-shm-usage',
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    });
    abort = () => { browser.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    const ctx = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block',
      acceptDownloads: false, offline: true });
    const page = await ctx.newPage();
    const internal = 'https://reader.invalid/';
    let served = false;
    await ctx.route('**/*', route => {
      if (served || route.request().url() !== internal || !route.request().isNavigationRequest()) {
        return route.abort();
      }
      served = true;
      return route.fulfill({ status: 200, contentType: document.type + '; charset=utf-8',
        headers: { 'Content-Security-Policy': "default-src 'none'; form-action 'none'; base-uri 'none'; sandbox" },
        body: document.body });
    });
    await page.goto(internal, { waitUntil: 'domcontentloaded', timeout: 8000 });
    const title = (await page.title()).trim().slice(0, 240);
    const text = (await page.locator('body').innerText({ timeout: 4000 })).trim().slice(0, 8000);
    return { title, text };
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    await browser?.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
}

export async function browse(input, { signal: externalSignal, fixtureOrigin } = {}) {
  const timeout = AbortSignal.timeout(deadlineMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  let url = validatedUrl(input);
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const address = await resolveAddress(url, signal, fixtureOrigin);
    const document = await fetchDocument(url, address, signal, url.origin !== fixtureOrigin);
    if (!document.redirect) {
      try {
        return { url: url.href, ...await render(document, signal) };
      } catch (cause) {
        signal.throwIfAborted();
        throw new Error('Browser could not render this page. Check the Chromium worker configuration.', { cause });
      }
    }
    if (redirects === 4) throw new Error('Too many redirects.');
    url = validatedUrl(new URL(document.redirect, url).href);
  }
}

export function makeBrowser({ fixtureOrigin } = {}) {
  return (url, { signal } = {}) => browse(url, { signal, fixtureOrigin });
}
