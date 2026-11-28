import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveOwner } from '../scripts/init-owner.mjs';
import { createOwnerAuth, hashPassword } from '../src/auth.mjs';

const username = 'owner';
const password = 'A long synthetic test pass:phrase.';
const passwordHash = await hashPassword(password);
const credentials = { username, passwordHash };
const origin = 'http://localhost:3000';
const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

async function call(auth, { method = 'GET', headers = {}, remoteAddress = '127.0.0.1', encrypted = false } = {}) {
  const req = { method, headers: { host: 'localhost:3000', ...headers }, socket: { remoteAddress, encrypted } };
  const res = {
    headers: {}, statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); },
  };
  return { allowed: await auth(req, res), res };
}

test('uses Argon2id with a fresh salt and validates owner configuration', async () => {
  assert.match(passwordHash, /^\$argon2id\$v=19\$/);
  assert.notEqual(await hashPassword(password), passwordHash);
  await assert.rejects(hashPassword('short'), /16 characters/);
  assert.throws(() => createOwnerAuth({ username: 'user:other', passwordHash }), /username/);
  assert.throws(() => createOwnerAuth({ username, passwordHash: 'broken' }), /hash/);
  assert.throws(() => createOwnerAuth({ ...credentials, publicOrigin: 'http://example.test' }), /HTTPS/);
});

test('challenges the owner and verifies Unicode, colons, and the full credential', async () => {
  const auth = createOwnerAuth(credentials);
  const anonymous = await call(auth);
  assert.equal(anonymous.allowed, false);
  assert.equal(anonymous.res.statusCode, 401);
  assert.match(anonymous.res.headers['WWW-Authenticate'], /^Basic /);
  const unicodePassword = 'x😀 a long test-only pass:phrase';
  const verify = createOwnerAuth({ username, passwordHash: await hashPassword(unicodePassword) });
  for (const [user, pass, expected] of [[username, unicodePassword, true], ['other', unicodePassword, false], [username, 'incorrect', false]]) {
    const header = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const result = await call(verify, { headers: { authorization: header } });
    assert.equal(result.allowed, expected);
    if (!expected) assert.equal(result.res.statusCode, 401);
  }
});

test('requires transport protection, and checks origin on browser and CLI writes', async () => {
  const auth = createOwnerAuth(credentials);
  const send = headers => call(auth, { method: 'POST', headers: { authorization, ...headers } });
  assert.equal((await call(auth, { headers: { authorization, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).allowed, true);
  assert.equal((await send({ origin })).allowed, true);
  assert.equal((await send({ 'sec-fetch-site': 'same-origin' })).allowed, true);
  assert.equal((await send({ 'x-requested-with': 'owner-console' })).allowed, true);
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://other.test' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await send(headers)).res.statusCode, 403);
  }
  assert.equal((await call(auth, { headers: { authorization, host: 'other.test' } })).res.statusCode, 403);
  assert.equal((await call(auth, { remoteAddress: '192.0.2.4', headers: { 'x-forwarded-proto': 'https' } })).res.statusCode, 403);

  const tls = createOwnerAuth({ ...credentials, publicOrigin: 'https://console.example.test' });
  const host = 'console.example.test';
  assert.equal((await call(tls, { headers: { host, authorization } })).res.statusCode, 403);
  assert.equal((await call(tls, { encrypted: true, headers: { host, authorization } })).allowed, true);
  assert.equal((await call(tls, { headers: { host, authorization, 'x-forwarded-proto': 'https' } })).allowed, true);
  assert.equal((await call(tls, { encrypted: true, headers: { host: 'wrong.test', authorization } })).res.statusCode, 403);
});

test('bounds repeated password checks and leaves previously verified credentials usable', async () => {
  const auth = createOwnerAuth(credentials);
  assert.equal((await call(auth, { headers: { authorization } })).allowed, true);
  const bad = { authorization: 'Basic ' + Buffer.from('owner:invalid').toString('base64') };
  for (let i = 0; i < 10; i++) assert.equal((await call(auth, { headers: bad })).res.statusCode, 401);
  const limited = await call(auth, { headers: bad });
  assert.equal(limited.res.statusCode, 429);
  assert.equal(limited.res.headers['Retry-After'], '60');
  assert.equal((await call(auth, { headers: { authorization } })).allowed, true);
});

test('bootstrap saves only a private verifier and refuses replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perottino-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveOwner({ dir, username, password });
  const path = join(dir, 'owner.json');
  const data = await readFile(path, 'utf8');
  assert.ok(!data.includes(password));
  assert.deepEqual(Object.keys(JSON.parse(data)).sort(), ['passwordHash', 'username']);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const auth = createOwnerAuth(JSON.parse(data));
  assert.equal((await call(auth, { headers: { authorization } })).allowed, true);
  await assert.rejects(saveOwner({ dir, username, password: 'Second completely different test password.' }), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), data);
  assert.deepEqual(await readdir(dir), ['owner.json']);
});

test('rate limits separate clients behind a trusted TLS ingress and ignore untrusted earlier hops', async () => {
  const host = 'console.example.test';
  const auth = createOwnerAuth({ ...credentials, publicOrigin: 'https://' + host });
  const bad = 'Basic ' + Buffer.from('owner:incorrect').toString('base64');
  const from = (forwarded, header = bad) => call(auth, {
    remoteAddress: '10.0.0.2', headers: { host, authorization: header,
      'x-forwarded-proto': 'https', 'x-forwarded-for': forwarded },
  });
  for (let i = 0; i < 10; i++) {
    assert.equal((await from('198.51.100.' + (i + 1) + ', 192.0.2.5:8001')).res.statusCode, 401);
  }
  assert.equal((await from('198.51.100.99, 192.0.2.5:8002')).res.statusCode, 429);
  assert.equal((await from('[2001:db8::1]:443', authorization)).allowed, true);
});
