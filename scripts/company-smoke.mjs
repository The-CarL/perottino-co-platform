import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConversations } from '../src/conversations.mjs';
import { createWork } from '../src/company-work.mjs';
import { createStore } from '../src/store.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { checkPortalFileLinks } from './portal-links-smoke.mjs';
import {
  checkOwnerTools,
  checkProjectCreation,
  prepareProjectHandoff,
  checkHandoffAndPromotion,
  checkBrowserControl,
} from './portal-smoke.mjs';

export async function runCompanySmoke() {
  // Exercise the documented entry points with a temporary owner and a real browser.
  const dataDir = await mkdtemp(join(tmpdir(), 'perottino-smoke-'));
  const username = 'smoke-owner';
  const password = randomBytes(32).toString('base64url');
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: '0',
    NODE_ENV: 'test',
    PEROTTINO_AGENT_MODE: 'local',
    // The browser fixture below opens only about:blank inside the isolated test runner.
    PEROTTINO_BROWSER_EXTERNAL_SANDBOX: '1',
    PEROTTINO_BROWSER_PROFILES: JSON.stringify([
      { id: 'smokelocal-0123456789', label: 'Offline smoke', origins: ['https://example.org'] },
    ]),
  };
  for (const key of ['OWNER_USERNAME', 'OWNER_PASSWORD', 'OWNER_PASSWORD_HASH', 'PUBLIC_ORIGIN'])
    delete env[key];
  const screenshots = process.env.PEROTTINO_SCREENSHOT_DIR;
  let service;
  let browser;

  async function prepareOwner() {
    const child = spawn(process.execPath, ['scripts/init-owner.mjs', '--password-stdin'], {
      env: { ...env, OWNER_USERNAME: username },
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    const exited = once(child, 'exit');
    child.stdin.end(password + '\n');
    assert.equal((await exited)[0], 0, 'owner initialization failed');
  }

  async function startServer() {
    service = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const child = service;
    return new Promise((ok, fail) => {
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error('Server startup timeout.'));
      }, 15000);
      child.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        fail(new Error('Server exited before listening.'));
      });
      child.stdout.on('data', (data) => {
        output += data;
        const match = output.match(/Owner console listening on 127\.0\.0\.1 (\d+)/);
        if (match) {
          clearTimeout(timer);
          ok('http://127.0.0.1:' + match[1]);
        }
      });
    });
  }

  async function stopServer() {
    if (!service || service.exitCode !== null || service.signalCode !== null) return;
    const child = service;
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 6000);
    try {
      await done;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function snapshot(page, name) {
    if (!screenshots) return;
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: resolve(screenshots, name + '.png') });
  }

  async function openPage(baseURL, viewport, path = '/') {
    const context = await browser.newContext({ baseURL, viewport, httpCredentials: { username, password } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(path);
    await page.locator('#content:not([aria-busy])').waitFor();
    return { context, page, errors };
  }
  async function nav(page, section) {
    const link = page.locator('#nav-' + section);
    if (!(await link.isVisible())) await page.locator('#menu').click();
    await link.click();
    await page.locator('#nav-' + section + '[aria-current=page]').waitFor({ state: 'attached' });
    await page.locator('#content:not([aria-busy])').waitFor();
  }
  async function send(page, text) {
    await page.locator('#messageText').fill(text);
    await page.locator('#send').click();
    await page.locator('#timeline .own .bubble').filter({ hasText: text }).first().waitFor();
  }
  const note = 'The test release needs a documented preview URL.';
  const goal = 'Document the release';
  const title = 'Review the release notes';
  const group = 'Release planning';
  const privateText = 'Employee-only conversation fixture.';
  try {
    await prepareOwner();
    const baseURL = await startServer();
    assert.equal((await fetch(baseURL + '/')).status, 401);
    assert.equal(
      (await fetch(baseURL + '/api/company/directory', { method: 'POST', headers: { Origin: baseURL } }))
        .status,
      401,
    );
    browser = await chromium.launch({
      executablePath: process.env.PEROTTINO_CHROMIUM_PATH || undefined,
      headless: true,
    });
    const first = await openPage(baseURL, { width: 1200, height: 820 });
    const { page } = first;
    const authenticatedApi = async (op, input = {}) => {
      const r = await first.context.request.post('/api/company/' + op, {
        headers: { 'X-Requested-With': 'owner-console' },
        data: input,
      });
      assert(r.ok(), op + ' returned ' + r.status());
      return r.json();
    };

    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    await page.getByText('No tasks need review or intervention.').waitFor();
    // Change pages while the previous request is still in flight.
    let releaseActivity;
    const activityGate = new Promise((resolve) => { releaseActivity = resolve; });
    await page.route('**/api/company/activity.list', async (route) => {
      await activityGate;
      await route.continue();
    }, { times: 1 });
    await page.locator('#nav-activity').click();
    await page.getByRole('heading', { name: 'Company events', exact: true }).waitFor();
    await nav(page, 'files');
    const activityFinished = page.waitForResponse((response) => response.url().endsWith('/api/company/activity.list'));
    releaseActivity();
    await activityFinished;
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('button', { name: 'New document', exact: true }).count(), 1);
    await nav(page, 'directory');
    await page.locator('#directory-search').fill('@ceo');
    await page.getByRole('button', { name: 'Message Mara', exact: true }).click();
    await send(page, 'Hello, Mara.');
    await page.locator('#timeline .employee .bubble').first().waitFor();
    const noWork = await authenticatedApi('company.overview');
    assert.deepEqual(noWork.goals, []);
    assert.deepEqual(noWork.tasks, []);
    await send(page, 'remember ' + note);
    await page.locator('#timeline .employee .bubble').filter({ hasText: 'saved that note' }).waitFor();
    await page.locator('#memoryButton').click();
    await page.locator('#dialog').getByText(note, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Source message' }).click();
    await page
      .locator('#dialog .bubble')
      .filter({ hasText: 'remember ' + note })
      .waitFor();
    await page.locator('#dialog-close').click();
    await snapshot(page, 'desktop-chat');
    await send(page, 'hire Engineer');
    await page
      .locator('#timeline .employee .bubble')
      .filter({ hasText: /hir(ed|e)/i })
      .waitFor();
    const employees = (await authenticatedApi('directory')).agents;
    const engineer = employees.find((a) => a.role.toLowerCase() === 'engineer');
    assert(engineer && engineer.managerId === 'ceo', 'CEO hire should be a distinct direct report');

    await checkOwnerTools({ page, nav, employeeId: engineer.id });
    await checkPortalFileLinks({ page, nav, api: authenticatedApi, employeeId: engineer.id });
    // Seed an employee-to-employee exchange through the real domain boundary.
    // The public owner API intentionally cannot impersonate either employee.
    const records = makeSqliteRecords({ filename: join(dataDir, 'company.sqlite') });
    let hidden;
    try {
      const service = createConversations({
        records,
        employee: async (id) => employees.find((a) => a.id === id),
      });
      hidden = (await service.execute('ceo', 'conversations.dm', { peerId: engineer.id })).conversation;
      await service.execute('ceo', 'messages.post', {
        conversationId: hidden.id,
        text: privateText,
        responders: [],
        requestId: 'browser-fixture',
      });
    } finally {
      records.close();
    }
    await nav(page, 'directory');
    await page.locator('#directory-search').fill(engineer.name);
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Pause employee', exact: true }).click();
    await page.locator('#dialog').waitFor({ state: 'hidden' });

    await nav(page, 'goals');
    await page.getByRole('button', { name: 'Create goal', exact: true }).click();
    await page.getByLabel('Outcome', { exact: true }).fill(goal);
    await page.getByLabel('Success criteria').fill('Reviewed notes and evidence.');
    await page.getByLabel('Accountable employee').selectOption(engineer.id);
    await page.locator('#dialog').getByRole('button', { name: 'Create goal', exact: true }).click();
    await page.getByRole('button', { name: 'Goal ' + goal, exact: true }).click();
    await page.locator('#dialog').getByRole('button', { name: 'Create task', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByLabel('Acceptance criteria').fill('Owner can inspect supporting evidence.');
    await page.getByLabel('Assignee').selectOption(engineer.id);
    await page.locator('#dialog').getByRole('button', { name: 'Create task', exact: true }).click();
    await page.locator('#dialog').waitFor({ state: 'hidden' });
    await nav(page, 'dashboard');
    await page.getByRole('button', { name: 'Goal ' + goal, exact: true }).waitFor();
    await snapshot(page, 'desktop-dashboard');
    const sourceProject = await checkProjectCreation({
      page,
      nav,
      send,
      api: authenticatedApi,
      engineer,
      goalOutcome: goal,
    });
    await nav(page, 'chat');
    assert.equal(await page.locator('[data-conversation-id="' + hidden.id + '"]').count(), 0);
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    await page.getByLabel('Group name').fill(group);
    await page.locator('#dialog').getByRole('checkbox', { name: /Mara/ }).check();
    await page
      .locator('#dialog')
      .getByRole('checkbox', { name: new RegExp(engineer.name) })
      .check();
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await page.getByRole('heading', { name: group, exact: true }).waitFor();
    await send(page, 'Shared release update.');
    assert.equal(await page.locator('#timeline .employee').count(), 0);
    await nav(page, 'admin');
    assert.equal(await page.locator('#composer').count(), 0);
    await page.locator('[data-conversation-id="' + hidden.id + '"]').click();
    await page.getByText(privateText, { exact: true }).waitFor();
    assert.equal(await page.locator('#composer').count(), 0);
    await page.getByRole('button', { name: 'Audit log', exact: true }).click();
    await page.locator('#dialog').getByText('Admin messages read', { exact: true }).first().waitFor();
    await page.locator('#dialog-close').click();
    await nav(page, 'chat');
    assert.equal(await page.getByText(privateText, { exact: true }).count(), 0);
    assert.equal(await page.locator('[data-conversation-id="' + hidden.id + '"]').count(), 0);
    assert.deepEqual(first.errors, []);
    await first.context.close();
    await stopServer();

    // An employee submits a reviewable deliverable while the local scheduler is offline.
    // The browser then exercises the owner's review against the same durable record.
    const reviewTitle = 'Verify the public release record';
    const reviewEvidence = 'https://example.org/releases/test';
    const storedEmployees = createStore(dataDir);
    const workRecords = makeSqliteRecords({ filename: join(dataDir, 'company.sqlite') });
    try {
      const work = createWork({ records: workRecords, employee: storedEmployees.employee });
      await prepareProjectHandoff({
        records: workRecords,
        store: storedEmployees,
        work,
        dataDir,
        project: sourceProject,
        employeeId: engineer.id,
      });
      const command = (actor, op, input) =>
        work.execute(actor, op, { ...input, requestId: crypto.randomUUID() });
      const { goal: evidenceGoal } = await command('owner', 'goal.create', {
        outcome: 'Verify release evidence',
        successCriteria: 'A reviewed public record.',
        accountableId: 'ceo',
      });
      const { task } = await command('owner', 'task.create', {
        goalId: evidenceGoal.id,
        title: reviewTitle,
        acceptance: 'Provide the release record link.',
        assigneeId: 'ceo',
      });
      const { claimToken } = await command('ceo', 'task.claim', { taskId: task.id });
      await command('ceo', 'task.submit', {
        taskId: task.id,
        claimToken,
        note: 'Release record checked.',
        evidence: [reviewEvidence, 'javascript:alert(1)'],
      });
    } finally {
      workRecords.close();
      storedEmployees.close();
    }

    const second = await openPage(await startServer(), { width: 390, height: 844 }, '/chat');
    const mobile = second.page;
    await checkHandoffAndPromotion({ page: mobile, nav, project: sourceProject, employeeId: engineer.id });
    await checkBrowserControl({ page: mobile, nav });
    await nav(mobile, 'chat');
    await mobile.locator('#conversation-list').getByRole('button', { name: 'Mara', exact: true }).click();
    await mobile
      .locator('#timeline')
      .getByText('remember ' + note, { exact: true })
      .waitFor();
    await send(mobile, 'recall release');
    await mobile.locator('#timeline .employee .bubble').filter({ hasText: note }).last().waitFor();
    await mobile.locator('#memoryButton').click();
    await mobile.locator('#dialog').getByText(note, { exact: true }).waitFor();
    await mobile.locator('#dialog-close').click();
    assert(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'mobile transcript overflows',
    );
    await snapshot(mobile, 'mobile-chat');
    await nav(mobile, 'tasks');
    await mobile.getByRole('button', { name: 'Task ' + reviewTitle, exact: true }).click();
    assert.equal(
      await mobile.locator('#dialog').getByRole('link', { name: reviewEvidence }).getAttribute('href'),
      reviewEvidence,
    );
    assert.equal(
      await mobile.locator('#dialog').getByRole('link', { name: 'javascript:alert(1)' }).count(),
      0,
    );
    await mobile.getByRole('button', { name: 'Review submission' }).click();
    await mobile.getByLabel('Decision').selectOption('accept');
    await mobile.getByLabel('Review note').fill('The submitted record satisfies the acceptance criteria.');
    await mobile.getByRole('button', { name: 'Save review' }).click();
    await mobile.locator('#dialog').waitFor({ state: 'hidden' });
    await mobile
      .getByRole('button', { name: 'Task ' + reviewTitle, exact: true })
      .getByText('Done', { exact: true })
      .waitFor();
    await mobile.getByRole('button', { name: 'Task ' + title, exact: true }).click();
    await mobile
      .locator('#dialog')
      .getByText('Owner can inspect supporting evidence.', { exact: true })
      .waitFor();
    await mobile.getByRole('button', { name: 'Task history', exact: true }).click();
    await mobile.getByRole('heading', { name: 'Task history', exact: true }).waitFor();
    await mobile.locator('#dialog-close').click();
    await nav(mobile, 'directory');
    await mobile.locator('#directory-search').fill(engineer.name);
    await mobile.getByRole('button', { name: 'Profile', exact: true }).click();
    await mobile.getByRole('button', { name: 'Resume employee', exact: true }).click();
    await mobile.locator('#dialog').waitFor({ state: 'hidden' });
    await mobile.locator('#directory-search').fill(engineer.name);
    await mobile.getByRole('button', { name: 'Profile', exact: true }).click();
    await mobile.getByRole('button', { name: 'Fire employee', exact: true }).click();
    await mobile.getByRole('button', { name: 'Cancel', exact: true }).click();
    await mobile.getByRole('button', { name: 'Profile', exact: true }).click();
    await mobile.getByRole('button', { name: 'Fire employee', exact: true }).click();
    await mobile.getByRole('button', { name: 'Confirm firing', exact: true }).click();
    await mobile.locator('#dialog').waitFor({ state: 'hidden' });
    await nav(mobile, 'dashboard');
    assert(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'mobile dashboard overflows',
    );
    await snapshot(mobile, 'mobile-dashboard');
    assert.deepEqual(second.errors, []);
    await second.context.close();
    console.log(
      'Company portal smoke passed for desktop, mobile, restart recovery, reviewed work, private chat and mail, protected file versions, model configuration, budgeted promotion, Git handoffs and browser takeover.',
      process.env.PEROTTINO_UI_DELIVERY === '1'
        ? 'Docker build, preview, release, withdrawal and temporary sandbox queue passed.'
        : '',
    );
  } finally {
    await browser?.close();
    await stopServer();
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runCompanySmoke();
