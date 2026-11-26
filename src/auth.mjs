import { argon2, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { promisify } from 'node:util';

const derive = promisify(argon2);
const parameters = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
const hashPrefix = '$argon2id$v=19$m=19456,t=2,p=1$';
const trialWindow = 60_000;
const maxTrials = 10;
const maxSources = 1024;
const maxConcurrentChecks = 4;

export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) {
    throw new Error('Use 1–64 letters, digits, periods, underscores, hyphens or @ for the owner username.');
  }
}

function parseHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(hashPrefix)) throw new Error('Invalid owner password hash.');
  const fields = hash.slice(hashPrefix.length).split('$');
  if (fields.length !== 2) throw new Error('Invalid owner password hash.');
  const [salt, tag] = fields.map(field => Buffer.from(field, 'base64'));
  if (salt.length !== 16 || tag.length !== 32 ||
      fields.some((field, i) => field !== [salt, tag][i].toString('base64').replace(/=+$/, ''))) {
    throw new Error('Invalid owner password hash.');
  }
  return { salt, tag };
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || [...password].length < 16 ||
      Buffer.byteLength(password) > 256 || /[\x00-\x1f\x7f]/u.test(password)) {
    throw new Error('Use a password of at least 16 characters and at most 256 UTF-8 bytes, without control characters.');
  }
  const salt = randomBytes(16);
  const tag = await derive('argon2id', { ...parameters, message: password, nonce: salt });
  return hashPrefix + [salt, tag].map(part => part.toString('base64').replace(/=+$/, '')).join('$');
}

function loopback(value = '') {
  const address = value.toLowerCase().replace(/^::ffff:/, '');
  return address === '::1' || (isIPv4(address) && address.startsWith('127.'));
}

function requestOrigin(req, configuredOrigin) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^[a-z\d.:\[\]-]+$/i.test(host)) return null;
  const encrypted = req.socket.encrypted === true;
  // Only an explicitly configured, access-restricted TLS ingress may attest this hop.
  const proxiedTls = configuredOrigin && req.headers['x-forwarded-proto'] === 'https';
  let url;
  try {
    url = new URL(`${encrypted || proxiedTls ? 'https' : 'http'}://${host}`);
  } catch {
    return null;
  }
  if (configuredOrigin) {
    return url.origin === configuredOrigin ? configuredOrigin : null;
  }
  if (encrypted) return url.origin;
  const localHost = url.hostname === 'localhost' || loopback(url.hostname.replace(/^\[|\]$/g, ''));
  return localHost && loopback(req.socket.remoteAddress) ? url.origin : null;
}

function allowedRequest(req, origin) {
  const source = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (source !== undefined && source !== origin) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // Permit the owner to follow a link from webmail while denying embedded cross-site requests.
    return site !== 'cross-site' || req.headers['sec-fetch-mode'] === 'navigate';
  }
  if (site !== undefined && site !== 'same-origin') return false;
  return source === origin || site === 'same-origin' || req.headers['x-requested-with'] === 'owner-console';
}

function deny(res, status, message) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="Perottino owner", charset="UTF-8"');
  if (status === 429) res.setHeader('Retry-After', '60');
  res.statusCode = status;
  res.end(JSON.stringify({ error: message }));
  return false;
}

export function createOwnerAuth({ username, passwordHash, publicOrigin }) {
  validateUsername(username);
  const { salt, tag } = parseHash(passwordHash);
  let configuredOrigin;
  if (publicOrigin !== undefined) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('The public origin must be an HTTPS origin.');
    }
    configuredOrigin = url.origin;
  }
  const failures = new Map();
  const cacheKey = randomBytes(32);
  let cachedDigest;
  let cacheUntil = 0;
  let activeChecks = 0;

  return async function requireOwner(req, res) {
    const origin = requestOrigin(req, configuredOrigin);
    if (!origin) return deny(res, 403, 'A secure connection is required.');
    if (!allowedRequest(req, origin)) return deny(res, 403, 'Request origin denied.');
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length > 512 || !/^Basic [A-Za-z0-9+/]+=*$/i.test(auth)) {
      return deny(res, 401, 'Owner sign-in required.');
    }
    const credentials = Buffer.from(auth.slice(6), 'base64');
    const colon = credentials.indexOf(58);
    if (colon < 1 || colon > 64 || credentials.length - colon - 1 > 256) {
      return deny(res, 401, 'Owner sign-in required.');
    }
    const now = Date.now();
    // A short-lived keyed digest avoids repeating a password hash for each authenticated asset request.
    const digest = createHmac('sha256', cacheKey).update(credentials).digest();
    if (now < cacheUntil && timingSafeEqual(cachedDigest, digest)) {
      credentials.fill(0);
      return true;
    }

    const source = req.socket.remoteAddress;
    const failed = failures.get(source);
    if (activeChecks >= maxConcurrentChecks || (failed?.until > now && failed.count >= maxTrials)) {
      return deny(res, 429, 'Try signing in again later.');
    }
    activeChecks++;
    try {
      const actual = await derive('argon2id', { ...parameters, message: credentials.subarray(colon + 1), nonce: salt });
      if (timingSafeEqual(actual, tag) && credentials.subarray(0, colon).equals(Buffer.from(username))) {
        cachedDigest = digest;
        cacheUntil = now + 300_000;
        failures.delete(source);
        return true;
      }
      const recent = failures.get(source);
      if (recent?.until > now) {
        recent.count++;
      } else {
        if (!failures.has(source) && failures.size >= maxSources) failures.delete(failures.keys().next().value);
        failures.set(source, { count: 1, until: now + trialWindow });
      }
      return deny(res, 401, 'Owner sign-in required.');
    } finally {
      activeChecks--;
      credentials.fill(0);
    }
  };
}
