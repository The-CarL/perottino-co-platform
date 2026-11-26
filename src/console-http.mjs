import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const maxActionBytes = 96 * 1024;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readAction(req, requireText) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new HttpError(415, 'Send an application/json request.');
  let length = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxActionBytes) {
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

async function readPage(store, agentId, section, query) {
  const cursors = query.getAll('cursor');
  if (cursors.length > 1 || (cursors.length && (!cursors[0] || cursors[0].length > 256))) {
    throw new HttpError(400, 'Invalid page cursor.');
  }
  const read = section === 'messages' ? store.messagePage : store.memoryPage;
  if (read) {
    try { return await read.call(store, agentId, cursors[0]); }
    catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, 'Invalid page cursor.');
      throw error;
    }
  }
  // The local SQLite pilot returns its complete transcript and never issues a cursor.
  if (cursors.length) throw new HttpError(400, 'Invalid page cursor.');
  return section === 'messages' ? store.messages(agentId) : { memories: await store.getMemories(agentId) };
}

export function createConsoleHandler({ store, auth, publicDir, mode, onEnqueued }) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method))
        return json(res, 200, { ok: true });
      if (!(await auth(req, res))) return;
      let url, pathname;
      try { url = new URL(req.url, 'http://localhost'); pathname = decodeURIComponent(url.pathname); }
      catch { throw new HttpError(400, 'Invalid URL.'); }
      if (!pathname.startsWith('/api/') && pathname !== '/api') return await servePage(req, res, pathname, publicDir);
      if (pathname === '/api/directory') {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
        return json(res, 200, { agents: await store.directory(), mode });
      }
      const route = /^\/api\/agents\/([a-zA-Z0-9_-]+)\/(memory|messages)(?:\/([a-zA-Z0-9_-]+))?$/.exec(pathname);
      if (!route || !(await store.getAgent(route[1]))) throw new HttpError(404, 'Resource not found.');
      const [, agentId, section, itemId] = route;
      if (itemId) {
        if (section === 'messages') {
          if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
          const message = store.messageSource ? await store.messageSource(agentId, itemId) :
            (await store.messages(agentId)).messages.find(m => m.id === itemId && m.author === 'owner');
          if (!message) throw new HttpError(404, 'Source message not found.');
          return json(res, 200, { message });
        }
        if (!['PATCH', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
        const { text, requestId } = await readAction(req, req.method === 'PATCH');
        const result = await store.changeMemory(agentId, itemId, req.method, requestId, text);
        if (result === 'missing') throw new HttpError(404, 'Memory not found.');
        if (result === 'conflict') throw new HttpError(409, 'That requestId belongs to a different action.');
        if (result === 'duplicate') throw new HttpError(409, 'An identical memory already exists.');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET') return json(res, 200, await readPage(store, agentId, section, url.searchParams));
      if (req.method !== 'POST' || section !== 'messages') throw new HttpError(405, 'Method not allowed.');
      const { text, requestId } = await readAction(req, true);
      const result = await store.enqueue(agentId, text, requestId);
      if (result.conflict) throw new HttpError(409, 'That requestId belongs to a different message.');
      json(res, 202, { message: result.message });
      if (onEnqueued) setImmediate(onEnqueued);
    } catch (error) {
      const known = error instanceof HttpError;
      if (!res.headersSent && !res.destroyed) json(res, known ? error.status : 500, { error: known ? error.message : 'The request could not be completed.' });
      if (!known) console.error('Request failed:', error.code || error.name);
    }
  };
}
