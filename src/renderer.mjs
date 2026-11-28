import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listenPrivateSocket } from './private-socket.mjs';

export const maxDocumentBytes = 1_048_576;
const maxTitleChars = 240;
const maxTextChars = 8000;
const renderTimeoutMs = 30_000;

export function checkedRenderResult(result) {
  const { title, text } = result ?? {};
  if (typeof title !== 'string' || title.length > maxTitleChars ||
      typeof text !== 'string' || text.length > maxTextChars) throw new Error('Invalid renderer output.');
  return { title, text };
}

// Render the fetched document in a fresh, offline browser. The remote page never receives
// credentials, opens subresources, executes scripts, or gets a socket into the worker's network.
export async function renderDocument(document, signal) {
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
    return await readBrowserDocument(browser, document);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    await browser?.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
}

export async function readBrowserDocument(browser, document) {
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
  const title = (await page.title()).trim().slice(0, maxTitleChars);
  const text = (await page.locator('body').innerText({ timeout: 4000 })).trim().slice(0, maxTextChars);
  return { title, text };
}

export async function listenRenderer(socket, render = renderDocument) {
  if (!socket) throw new Error('The renderer requires a private Unix socket.');
  let active = false;
  const server = http.createServer({
    requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000,
  }, async (req, res) => {
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST' || req.url !== '/render') { res.writeHead(404).end(); return; }
    const type = req.headers['content-type'];
    if (!['text/html', 'text/plain'].includes(type) || req.headers['content-encoding']) {
      res.writeHead(415).end(); return;
    }
    const length = req.headers['content-length'];
    if (!/^\d+$/.test(length ?? '')) { res.writeHead(411).end(); return; }
    if (Number(length) > maxDocumentBytes) { res.writeHead(413).end(); return; }
    if (active) { res.writeHead(429).end(); return; }
    active = true;
    const disconnect = new AbortController();
    res.once('close', () => disconnect.abort());
    const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(renderTimeoutMs)]);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxDocumentBytes) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      const result = checkedRenderResult(await render({ type, body: Buffer.concat(chunks) }, signal));
      signal.throwIfAborted();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      if (!res.destroyed && !res.headersSent) res.writeHead(502).end();
    } finally { active = false; }
  });
  server.maxConnections = 8;
  return listenPrivateSocket(server, socket);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  listenRenderer(process.env.PEROTTINO_BROWSER_RENDER_SOCKET).then(server => {
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => server.close());
  }).catch(() => { console.error('Unable to open the private renderer socket.'); process.exitCode = 1; });
}
