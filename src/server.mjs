import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConsoleHandler } from './console-http.mjs';
import { createOwnerAuth } from './auth.mjs';
import { createTurnTools, runTurn, validateWorkerConnection } from './agent.mjs';
import { makeBrowser } from './browser.mjs';
import { createStore } from './store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function createWorker(store, runner, browser, turnTimeoutMs) {
  const active = new Map();
  let stopping = false;
  async function work(job, controller) {
    const { signal } = controller;
    const { pending, remember, recall, browse } = createTurnTools(job, browser, signal);
    const timeout = setTimeout(() => controller.abort(new Error('Turn timed out.')), turnTimeoutMs);
    const aborted = new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    try {
      const reply = await Promise.race([runner({
        agent: job.agent, message: job.message, history: job.history, memories: job.memories, remember, recall,
        browse, signal
      }), aborted]);
      signal.throwIfAborted();
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Empty reply.');
      try {
        store.complete(job, reply.trim(), pending);
      } catch {
        // A transient disk error leaves the durable lease recoverable. Replaying
        // the transaction can never expose a partial reply or partial notes.
        console.error('Could not commit turn; the dispatcher will recover its lease:', job.message.id);
      }
    } catch {
      try {
        if (stopping) store.release(job);
        else {
          store.fail(job);
          console.error('Turn failed:', job.agent.id, job.message.id, signal.aborted ? 'timeout' : 'execution error');
        }
      } catch {
        console.error('Could not update turn; the dispatcher will recover its lease:', job.message.id);
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
  if (mode === 'bedrock' && runner === runTurn) validateWorkerConnection();
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) throw new Error('Invalid turn timeout.');
  const auth = createOwnerAuth({ username, passwordHash, publicOrigin });
  const store = createStore(dataDir);
  const worker = createWorker(store, runner, browser, turnTimeoutMs);
  const server = createServer(createConsoleHandler({ store, auth, publicDir, mode, onEnqueued: worker.wake }));
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
