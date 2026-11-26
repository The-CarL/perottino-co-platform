import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createOwnerAuth, preflightOwnerRequest } from './auth.mjs';
import { createConsoleHandler, HttpError, maxActionBytes } from './console-http.mjs';

const publicFiles = fileURLToPath(new URL('../public/', import.meta.url));
const secretCacheMs = 30_000;
const requestHeaders = new Set([
  'authorization', 'content-type', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'x-requested-with',
]);

function ownerMiddleware(readOwner, publicOrigin, now) {
  let current;
  let expiresAt = 0;
  let fetching;
  async function refresh() {
    const { username, passwordHash } = await readOwner();
    if (!current || current.username !== username || current.passwordHash !== passwordHash) {
      current = { username, passwordHash, verify: createOwnerAuth({ username, passwordHash, publicOrigin }) };
    }
    expiresAt = now() + secretCacheMs;
  }
  return async (req, res) => {
    if (now() >= expiresAt || !current) {
      if (!preflightOwnerRequest(req, res, publicOrigin)) return false;
      fetching ??= refresh().finally(() => { fetching = undefined; });
      try { await fetching; }
      catch { throw new HttpError(503, 'Owner sign-in is temporarily unavailable.'); }
    }
    return current.verify(req, res);
  };
}

function* requestBody(event) {
  const data = event.body ?? '';
  if (typeof data !== 'string') throw new HttpError(400, 'Invalid request body.');
  const maxLength = event.isBase64Encoded ? Math.ceil(maxActionBytes / 3) * 4 : maxActionBytes;
  if (data.length > maxLength) throw new HttpError(413, 'Message is too large.');
  const bytes = Buffer.from(data, event.isBase64Encoded ? 'base64' : 'utf8');
  if (event.isBase64Encoded && bytes.toString('base64') !== data) throw new HttpError(400, 'Invalid request body.');
  yield bytes;
}

function gatewayRequest(event, publicOrigin) {
  const http = event?.requestContext?.http;
  const domain = event?.requestContext?.domainName;
  if (event?.version !== '2.0' || typeof domain !== 'string' || domain.length > 253 ||
      !domain.includes('.') || !domain.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) ||
      !isIP(http?.sourceIp) || !/^[A-Z]{1,16}$/.test(http?.method ?? '') ||
      typeof event.rawPath !== 'string' || !event.rawPath.startsWith('/')) return null;
  const host = domain.toLowerCase();
  if (publicOrigin && 'https://' + host !== publicOrigin) return null;
  const headers = { host };
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    const name = key.toLowerCase();
    if (name === 'host' && (typeof value !== 'string' || value.toLowerCase() !== host)) return null;
    if (requestHeaders.has(name)) {
      if (typeof value !== 'string' || Object.hasOwn(headers, name)) return null;
      headers[name] = value;
    }
  }
  // The gateway supplies the TLS endpoint and source address. Client-supplied forwarding headers have no authority.
  return Object.assign(Readable.from(requestBody(event)), {
    method: http.method, url: event.rawPath + (event.rawQueryString ? '?' + event.rawQueryString : ''),
    headers, socket: { encrypted: true, remoteAddress: http.sourceIp },
  });
}

function gatewayResponse(method) {
  const headers = { 'strict-transport-security': 'max-age=31536000' };
  return {
    statusCode: 200, headersSent: false, result: undefined,
    setHeader(name, value) { headers[name.toLowerCase()] = String(value); },
    writeHead(status, values) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      this.headersSent = true;
    },
    end(body) {
      this.headersSent = true;
      const binary = method !== 'HEAD' && Buffer.isBuffer(body) && !/^text\/|^image\/svg\+xml/.test(headers['content-type'] ?? '');
      this.result = { statusCode: this.statusCode, headers, isBase64Encoded: binary,
        body: method === 'HEAD' || body === undefined ? '' : binary ? body.toString('base64') : body.toString() };
    },
  };
}

function reject(statusCode, message) {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000' },
  body: JSON.stringify({ error: message }) };
}

export function createCloudHandler({ store, readOwner, publicOrigin, publicDir = publicFiles, now = Date.now }) {
  let expected;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.href !== url.origin + '/') throw new Error('PUBLIC_ORIGIN must be an HTTPS origin.');
    expected = url.origin;
  }
  const handle = createConsoleHandler({ store, mode: 'bedrock', publicDir, auth: ownerMiddleware(readOwner, expected, now) });
  return async event => {
    const req = gatewayRequest(event, expected);
    if (!req) return reject(403, 'Request source denied.');
    const res = gatewayResponse(req.method);
    try { await handle(req, res); }
    finally { req.destroy(); }
    // Lambda counts the serialized proxy envelope, including escaped JSON inside body.
    // Pages are bounded at the store. Guard other responses before the native 6 MiB limit.
    if (res.result.body.length > 512 * 1024 && Buffer.byteLength(JSON.stringify(res.result)) > 5.75 * 1024 * 1024) {
      return reject(502, 'The requested response exceeded its size limit.');
    }
    return res.result;
  };
}

async function production() {
  const tableName = process.env.PEROTTINO_STATE_TABLE;
  const secretArn = process.env.PEROTTINO_OWNER_SECRET_ARN;
  if (!tableName || !secretArn) throw new Error('Missing owner API configuration.');
  const [{ createCloudStore }, { SecretsManagerClient, GetSecretValueCommand }] = await Promise.all([
    import('./cloud-store.mjs'), import('@aws-sdk/client-secrets-manager'),
  ]);
  const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION, maxAttempts: 2 });
  return createCloudHandler({
    store: await createCloudStore({ tableName }), publicOrigin: process.env.PUBLIC_ORIGIN,
    readOwner: async () => {
      const value = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }),
        { abortSignal: AbortSignal.timeout(4000) });
      return JSON.parse(value.SecretString);
    },
  });
}

let initialized;
export async function handler(event) {
  try {
    initialized ??= production().catch(error => { initialized = undefined; throw error; });
    return await (await initialized)(event);
  } catch {
    console.error('Owner API unavailable.');
    return reject(503, 'The service is temporarily unavailable.');
  }
}
