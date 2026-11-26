import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOwnerAuth } from './auth.mjs';
import { runTurn } from './agent.mjs';
import { makeBrowser } from './browser.mjs';
import { createStore } from './store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readAction(req, requireText) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new HttpError(415, 'Send an application/json request.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 96 * 1024) {
      req.resume();
      throw new HttpError(413, 'Message is too large.');
    }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Message must be valid JSON.'); }
  if (typeof body?.requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(body.requestId))
    throw new HttpError(400, 'Supply a unique requestId.');
  if (!requireText) return { requestId: body.requestId };
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000)
    throw new HttpError(400, 'Text must contain 1 to 16,000 characters.');
  return { text: body.text.trim(), requestId: body.requestId };
}

async function servePage(req, res, pathname, publicDir) {
  if (!['GET','HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
  const segments = pathname.split('/');
  if (segments.some(part => part.startsWith('.') || part.includes('\\') || part.includes('\0')))
    throw new HttpError(404, 'Page not found.');
  const base = await realpath(publicDir);
  let file = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
  try { file = await realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    if (extname(pathname)) throw new HttpError(404, 'Page not found.');
    file = await realpath(resolve(base, 'index.html'));
  }
  if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) throw new HttpError(404, 'Page not found.');
  const data = await readFile(file);
  res.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function createWorker(store, runner, browser, turnTimeoutMs) {
  const active = new Map();
  let stopping = false;
  async function work(job, controller) {
    const { signal } = controller;
    const pending = [];
    function remember(text) {
      signal.throwIfAborted();
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid memory.');
      text = text.trim();
      const existing = [...job.memories, ...pending].find(item => item.text === text);
      if (existing) return existing;
      if (pending.length >= 32) throw new Error('Memory limit reached for this turn.');
      const item = { id: randomUUID(), text, sourceMessageId: job.message.id, createdAt: new Date().toISOString() };
      pending.push(item);
      return item;
    }
    function recall(query = '') {
      signal.throwIfAborted();
      const needle = String(query).trim().toLowerCase();
      return [...job.memories, ...pending].filter(item => item.text.toLowerCase().includes(needle));
    }
    const timeout = setTimeout(() => controller.abort(new Error('Turn timed out.')), turnTimeoutMs);
    const aborted = new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    try {
      const reply = await Promise.race([runner({
        agent: job.agent, message: job.message, history: job.history, memories: job.memories, remember, recall,
        browse: async url => { signal.throwIfAborted(); const page = await browser(url, { signal }); signal.throwIfAborted(); return page; }, signal
      }), aborted]);
      signal.throwIfAborted();
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Empty reply.');
      store.complete(job, reply.trim(), pending);
    } catch {
      if (stopping) store.release(job);
      else {
        store.fail(job);
        console.error('Turn failed:', job.agent.id, job.message.id, signal.aborted ? 'timeout' : 'execution error');
      }
    } finally {
      clearTimeout(timeout);
      active.delete(job.token);
      if (!stopping) setImmediate(wake);
    }
  }

  function wake() {
    if (stopping) return;
    try {
      while (active.size < 4) {
        const job = store.claim(turnTimeoutMs + 10_000);
        if (!job) break;
        const controller = new AbortController();
        // Register before starting the runner, including for synchronous failures.
        const done = Promise.resolve().then(() => work(job, controller));
        active.set(job.token, { controller, done });
      }
    } catch { console.error('Could not claim queued work. The dispatcher will retry.'); }
  }
  const poll = setInterval(wake, 1000);
  poll.unref();
  setImmediate(wake);
  return { wake, async stop() {
    stopping = true;
    clearInterval(poll);
    const jobs = [...active.values()];
    for (const { controller } of jobs) controller.abort(new Error('Server is stopping.'));
    await Promise.allSettled(jobs.map(job => job.done));
  }};
}

export function createApp({ dataDir, username, passwordHash, publicOrigin, runner = runTurn, browser = makeBrowser(),
  publicDir = resolve(root, 'public'), turnTimeoutMs = 120000 } = {}) {
  const mode = process.env.PEROTTINO_AGENT_MODE ?? 'local';
  if (!['local', 'bedrock'].includes(mode)) throw new Error('PEROTTINO_AGENT_MODE must be local or bedrock.');
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) throw new Error('Invalid turn timeout.');
  const auth = createOwnerAuth({ username, passwordHash, publicOrigin });
  const store = createStore(dataDir);
  const worker = createWorker(store, runner, browser, turnTimeoutMs);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method))
        return json(res, 200, { ok: true });
      if (!(await auth(req, res))) return;
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch { throw new HttpError(400, 'Invalid URL.'); }
      if (!pathname.startsWith('/api/') && pathname !== '/api') return await servePage(req, res, pathname, publicDir);
      if (pathname === '/api/directory') {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
        return json(res, 200, { agents: store.directory(), mode });
      }
      const route = /^\/api\/agents\/([a-zA-Z0-9_-]+)\/(memory|messages)(?:\/([a-zA-Z0-9_-]+))?$/.exec(pathname);
      if (!route || !store.getAgent(route[1])) throw new HttpError(404, 'Resource not found.');
      const [, agentId, section, itemId] = route;
      if (itemId) {
        if (section !== 'memory') throw new HttpError(404, 'Resource not found.');
        if (!['PATCH', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
        const { text, requestId } = await readAction(req, req.method === 'PATCH');
        const result = store.changeMemory(agentId, itemId, req.method, requestId, text);
        if (result === 'missing') throw new HttpError(404, 'Memory not found.');
        if (result === 'conflict') throw new HttpError(409, 'That requestId belongs to a different action.');
        if (result === 'duplicate') throw new HttpError(409, 'An identical memory already exists.');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET') return json(res, 200, section === 'memory'
        ? { memories: store.getMemories(agentId) } : store.messages(agentId));
      if (req.method !== 'POST' || section !== 'messages') throw new HttpError(405, 'Method not allowed.');
      const { text, requestId } = await readAction(req, true);
      const result = store.enqueue(agentId, text, requestId);
      if (result.conflict) throw new HttpError(409, 'That requestId belongs to a different message.');
      json(res, 202, { message: result.message });
      setImmediate(worker.wake);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
      if (!error.status) console.error('Request failed:', error.code || error.name);
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  let closing;
  function close() {
    closing ??= (async () => {
      const httpClosed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      await Promise.all([httpClosed, worker.stop()]);
      store.close();
    })();
    return closing;
  }
  return { server, close };
}

async function main() {
  const dataDir = resolve(process.env.DATA_DIR || '.local');
  let username = process.env.OWNER_USERNAME;
  let passwordHash = process.env.OWNER_PASSWORD_HASH;
  if (!username && !passwordHash && process.env.NODE_ENV !== 'production') {
    try { ({ username, passwordHash } = JSON.parse(await readFile(resolve(dataDir, 'owner.json'), 'utf8'))); }
    catch { throw new Error('Configure owner credentials or initialize the local owner file.'); }
  }
  if (!username || !passwordHash) throw new Error('OWNER_USERNAME and OWNER_PASSWORD_HASH are required.');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
  const app = createApp({ dataDir, username, passwordHash, publicOrigin: process.env.PUBLIC_ORIGIN || undefined });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, host, resolve);
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log('Owner console listening on', host, app.server.address().port);
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => { void app.close(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
