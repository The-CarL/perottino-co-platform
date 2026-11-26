import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

// Exercise the documented entry points with a temporary owner and a real browser.
const dataDir = await mkdtemp(join(tmpdir(), 'perottino-smoke-'));
const username = 'smoke-owner';
const password = randomBytes(32).toString('base64url');
const env = { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0',
  NODE_ENV: 'test', PEROTTINO_AGENT_MODE: 'local' };
for (const key of ['OWNER_USERNAME', 'OWNER_PASSWORD', 'OWNER_PASSWORD_HASH', 'PUBLIC_ORIGIN']) delete env[key];
const screenshots = process.env.PEROTTINO_SCREENSHOT_DIR;
let service;
let browser;

async function prepareOwner() {
  const child = spawn(process.execPath, ['scripts/init-owner.mjs', '--password-stdin'],
    { env: { ...env, OWNER_USERNAME: username }, stdio: ['pipe', 'ignore', 'inherit'] });
  const exited = once(child, 'exit');
  child.stdin.end(password + '\n');
  assert.equal((await exited)[0], 0, 'owner initialization failed');
}

async function startServer() {
  service = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const child = service;
  return new Promise((ok, fail) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); fail(new Error('Server startup timeout.')); }, 15000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', () => { clearTimeout(timer); fail(new Error('Server exited before listening.')); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Owner console listening on 127\.0\.0\.1 (\d+)/);
      if (match) { clearTimeout(timer); ok('http://127.0.0.1:' + match[1]); }
    });
  });
}

async function stopServer() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  const child = service;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 6000);
  try { await done; } finally { clearTimeout(timeout); }
}

async function snapshot(page, name) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, name + '.png') });
}

async function openChat(baseURL, viewport) {
  const context = await browser.newContext({ baseURL, viewport, httpCredentials: { username, password } });
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto('/chat');
  await page.waitForFunction(() => document.querySelector('#contactName')?.textContent.includes('Mara'));
  return { context, page };
}

const note = 'Launch briefs include a working preview link.';
try {
  await prepareOwner();
  const firstURL = await startServer();
  assert.equal((await fetch(firstURL + '/api/directory')).status, 401);
  browser = await chromium.launch({
    executablePath: process.env.PEROTTINO_CHROMIUM_PATH || undefined,
    headless: true,
  });
  const first = await openChat(firstURL, { width: 1200, height: 820 });
  await first.page.locator('#directory').click();
  await first.page.locator('#search').fill('@ceo');
  await first.page.locator('#picker').getByRole('button', { name: /Mara/i }).click();
  await first.page.locator('#messageText').fill('remember ' + note);
  await first.page.locator('#send').click();
  await first.page.waitForFunction(async () => {
    const result = await fetch('/api/agents/ceo/messages').then(r => r.json());
    return result.status === 'idle' && result.messages.some(m => m.author === 'agent');
  });
  await first.page.locator('#memoryButton').click();
  await first.page.locator('#memories').getByText(note, { exact: true }).waitFor();
  await first.page.locator('#closeMemory').click();
  await snapshot(first.page, 'desktop-chat');
  await first.context.close();
  await stopServer();

  const secondURL = await startServer();
  const second = await openChat(secondURL, { width: 390, height: 844 });
  await second.page.locator('#openSidebar').click();
  await second.page.locator('#conversations').getByRole('button', { name: /Mara/i }).click();
  await second.page.locator('#messageText').fill('recall preview');
  await second.page.locator('#send').click();
  await second.page.waitForFunction(async expected => {
    const result = await fetch('/api/agents/ceo/messages').then(r => r.json());
    return result.messages.length === 4 && result.messages[3].author === 'agent' && result.messages[3].text.includes(expected);
  }, note);
  assert(await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout overflowed');
  await snapshot(second.page, 'mobile-chat');
  await second.context.close();
  console.log('Smoke passed: owner auth, directory alias, DM, sourced memory, process restart, mobile recall.');
} finally {
  await browser?.close();
  await stopServer();
  await rm(dataDir, { recursive: true, force: true });
}
