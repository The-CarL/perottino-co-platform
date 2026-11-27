import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { listenServer } from './private-socket.mjs';

const responsesPath = '/openai/v1/responses';
const maxRequestBytes = 2 * 1024 * 1024;
const maxResponseBytes = 8 * 1024 * 1024;
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function endToEndHeaders(headers) {
  const result = { ...headers };
  const connectionFields = (headers.connection || '').toLowerCase().split(',');
  for (const field of [...hopHeaders, ...connectionFields]) delete result[field.trim()];
  return result;
}

// Codex signs the AWS Host and the final path. Only the outer TLS connection
// originates in Node. The relay has no credential provider or signing facility.
export async function startBedrockRelay(region, signal, requestUpstream = https.request) {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/.test(region)) throw new Error('Invalid Bedrock region.');
  signal?.throwIfAborted();
  const hostname = 'bedrock-runtime.' + region + '.amazonaws.com';
  const scope = '/' + region + '/bedrock/aws4_request,';
  const lifetime = new AbortController();
  let used = false;
  const server = http.createServer({ maxHeaderSize: 16_384, headersTimeout: 5_000, requestTimeout: 15_000 }, (req, res) => {
    if (req.method !== 'POST' || req.url !== responsesPath) return res.writeHead(404).end();
    if (req.headers.host !== hostname || !req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=') ||
        !req.headers.authorization.includes(scope)) return res.writeHead(403).end();
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return res.writeHead(415).end();
    const bytes = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxRequestBytes) return res.writeHead(413).end();
    if (used) return res.writeHead(409).end();
    used = true;

    const headers = endToEndHeaders(req.headers);
    headers.host = hostname;
    const outbound = requestUpstream({ protocol: 'https:', hostname, port: 443, servername: hostname,
      path: responsesPath, method: 'POST', headers, agent: false, rejectUnauthorized: true, signal: lifetime.signal,
    }, upstream => {
      // Passing a Location back to the CLI could cause it to follow a redirect.
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
        upstream.destroy();
        res.writeHead(502).end();
        return;
      }
      const responseHeaders = endToEndHeaders(upstream.headers);
      delete responseHeaders.location;
      res.writeHead(upstream.statusCode, responseHeaders);
      let received = 0;
      const bound = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maxResponseBytes) callback(new Error('Bedrock response exceeds the size limit.'));
        else callback(null, chunk);
      } });
      // pipeline handles backpressure and tears down both ends on early EOF.
      pipeline(upstream, bound, res).catch(() => res.destroy());
    });
    outbound.on('error', () => {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
      else res.destroy();
    });
    req.on('error', () => outbound.destroy());
    res.on('close', () => outbound.destroy());
    req.pipe(outbound);
  });
  server.maxConnections = 4;
  await listenServer(server, 0, '127.0.0.1');
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/openai/v1';
  let closing;
  function close() {
    if (!closing) {
      signal?.removeEventListener('abort', close);
      lifetime.abort();
      closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
    }
    return closing;
  }
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  return { baseUrl, hostname, close };
}
