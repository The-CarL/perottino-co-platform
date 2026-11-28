import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjects } from '../src/company-projects.mjs';
import { createLocalProjectGit } from '../src/project-git-local.mjs';

const projectName = 'Service bulletin',
  file = 'projects/bulletins/notes.md';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const close = (page) => page.locator('#dialog-close').click();
const dialog = (page) => page.locator('#dialog');
async function heading(page, name) {
  await dialog(page).getByRole('heading', { name, exact: true }).waitFor();
}

export async function checkOwnerTools({ page, nav, employeeId }) {
  await nav(page, 'files');
  await button(page, 'New document').click();
  await page.getByLabel('File path').fill(file);
  await page.getByLabel('Contents').fill('Initial owner note');
  await button(page, 'Save document').click();
  await dialog(page).getByText('Initial owner note', { exact: true }).waitFor();
  await button(page, 'Edit document').click();
  await page.getByLabel('Contents').fill('Updated owner note');
  await button(page, 'Save document').click();
  await dialog(page).getByText('Updated owner note', { exact: true }).waitFor();
  await button(page, 'Version history').click();
  await dialog(page)
    .getByRole('button', { name: /Version 1/ })
    .click();
  await dialog(page).getByText('Initial owner note', { exact: true }).waitFor();
  await button(page, 'Restore this version').click();
  await button(page, 'Restore version').click();
  await dialog(page).getByText('Initial owner note', { exact: true }).waitFor();
  await close(page);
  await button(page, 'Upload file').click();
  const payload = Buffer.alloc(70_871, 37);
  payload[0] = 0;
  payload[payload.length - 1] = 255;
  await page
    .getByLabel('Select file')
    .setInputFiles({ name: 'report.bin', mimeType: 'application/octet-stream', buffer: payload });
  await page.getByLabel('Destination path').fill('projects/bulletins/report.bin');
  await button(page, 'Upload').click();
  await heading(page, 'report.bin');
  const reading = page.waitForEvent('download');
  await button(page, 'Download').click();
  const stream = await (await reading).createReadStream();
  const chunks = [];
  for await (const part of stream) chunks.push(part);
  assert.deepEqual(Buffer.concat(chunks), payload);
  await close(page);
  await nav(page, 'directory');
  await page.locator('#directory-search').fill('@ceo');
  await button(page, 'Profile').click();
  await button(page, 'SOUL.md').click();
  await heading(page, 'SOUL.md');
  await button(page, 'Edit document').click();
  const originalSoul = await page.getByLabel('Contents').inputValue();
  await page.getByLabel('Contents').fill(originalSoul + '\nCheck the supporting handoff.');
  await button(page, 'Save document').click();
  await dialog(page)
    .getByText(/Check the supporting handoff/)
    .waitFor();
  await close(page);
  await button(page, 'Profile').click();
  await button(page, 'Employee memory').click();
  await button(page, 'Add memory').click();
  await page.getByLabel('Memory text').fill('Recheck the source.');
  await button(page, 'Save memory').click();
  await button(page, 'Correct').click();
  await page.getByLabel('Memory text').fill('Recheck the signed source.');
  await button(page, 'Save memory').click();
  await dialog(page).getByText('Recheck the signed source.', { exact: true }).waitFor();
  await button(page, 'Forget').click();
  await button(page, 'Confirm forgetting').click();
  await dialog(page).getByText('No employee memories yet.').waitFor();
  await close(page);
  await nav(page, 'settings');
  await button(page, 'Edit configuration').click();
  await page.getByLabel('Company mandate').fill('Maintain testable public-data reports.');
  await button(page, 'Publish configuration').click();
  await page.getByText('Maintain testable public-data reports.', { exact: true }).waitFor();
  await page.getByLabel('Configuration scope').selectOption('employee');
  await page.getByLabel('Employee', { exact: true }).selectOption(employeeId);
  await button(page, 'Edit configuration').click();
  await page.getByLabel('Reasoning effort').selectOption('high');
  await page.getByLabel('Web access').selectOption('false');
  await button(page, 'Publish configuration').click();
  await button(page, 'Effective settings').click();
  await dialog(page)
    .getByText(/Maintain testable public-data reports/)
    .waitFor();
  await dialog(page).getByText(/^high/).waitFor();
  await close(page);
  await button(page, 'Policy and budget').click();
  await button(page, 'Edit policy').click();
  await page.getByLabel('Company budget (USD)').fill('12.50');
  await page.getByLabel('Allocation ceiling (USD)').fill('3.00');
  await page.getByLabel('Maximum direct reports').fill('3');
  await button(page, 'Save policy').click();
  await page.getByText('$12.50', { exact: true }).waitFor();
  await page
    .locator('#content')
    .getByRole('button', { name: /Engineer/i })
    .click();
  await button(page, 'Allocate budget').click();
  await page.getByLabel('Amount (USD)').fill('2.50');
  await button(page, 'Allocate').click();
  await dialog(page).getByText('$2.50', { exact: true }).first().waitFor();
  await close(page);
  await nav(page, 'mail');
  await button(page, 'Compose email').click();
  await page.getByLabel('Send as').selectOption('ceo');
  await page.getByLabel('To', { exact: true }).fill('reader@example.test');
  await page.getByLabel('Subject', { exact: true }).fill('Bulletin review');
  await page.getByLabel('Email message').fill('The bulletin is ready for review.');
  await button(page, 'Send email').click();
  await dialog(page).getByText('The bulletin is ready for review.', { exact: true }).waitFor();
  await button(page, 'Reply to this message').click();
  await page.getByLabel('Email reply').fill('The follow-up stays in this thread.');
  await button(page, 'Send reply').click();
  await dialog(page).getByText('The follow-up stays in this thread.', { exact: true }).waitFor();
  await dialog(page)
    .getByText(/External messages are captured locally/)
    .waitFor();
  await close(page);
}

export async function checkProjectCreation({ page, nav, send, api, engineer, goalOutcome }) {
  await nav(page, 'projects');
  await button(page, 'Create project').click();
  await page.getByLabel('Project name').fill(projectName);
  await page.getByLabel('Goal', { exact: true }).selectOption({ label: goalOutcome });
  await dialog(page).getByRole('button', { name: 'Create project' }).click();
  await heading(page, projectName);
  if (process.env.PEROTTINO_UI_DELIVERY === '1') {
    await button(page, 'Sandbox resources').click();
    await button(page, 'Provision temporary queue').click();
    await page.getByLabel('Lifetime (hours)').fill('1');
    await button(page, 'Create queue').click();
    await heading(page, 'Private queue');
    await dialog(page).getByText('Active', { exact: true }).waitFor();
    const id = await dialog(page)
      .locator('dt')
      .filter({ hasText: 'Resource ID' })
      .locator('xpath=following-sibling::dd[1]')
      .innerText();
    await close(page);
    await page.getByRole('button', { name: new RegExp(projectName) }).click();
    await button(page, 'Sandbox resources').click();
    await dialog(page)
      .getByRole('button', { name: new RegExp(id) })
      .click();
    await button(page, 'Remove queue').click();
    await button(page, 'Confirm queue removal').click();
    await heading(page, 'Sandbox resources');
    await close(page);
    await page.getByRole('button', { name: new RegExp(projectName) }).click();
  }
  await button(page, 'Project conversation').click();
  assert.equal(await page.getByLabel('Group name').inputValue(), projectName);
  await dialog(page)
    .getByRole('checkbox', { name: new RegExp(engineer.name) })
    .check();
  await button(page, 'Create group').click();
  await page.getByRole('heading', { name: projectName, exact: true }).waitFor();
  await send(page, 'Bulletin editorial decisions go here.');
  await nav(page, 'files');
  await nav(page, 'chat');
  await page.locator('#conversation-list').getByRole('button', { name: projectName, exact: true }).click();
  await page.getByText('Bulletin editorial decisions go here.', { exact: true }).waitFor();
  await nav(page, 'projects');
  await page.getByRole('button', { name: new RegExp(projectName) }).click();
  await button(page, 'Project conversation').click();
  await heading(page, 'Project conversations');
  await dialog(page)
    .getByRole('button', { name: new RegExp(projectName) })
    .click();
  await page.getByText('Bulletin editorial decisions go here.', { exact: true }).waitFor();
  const rows = (await api('project.list')).projects.filter((p) => p.name === projectName);
  assert.equal(rows.length, 1);
  return rows[0];
}

export async function prepareProjectHandoff({ records, store, work, dataDir, project, employeeId }) {
  const changeState = (operation) =>
    store.setEmployeeState({ operation, agentId: employeeId, requestId: randomUUID() });
  // The browser deliberately paused this employee earlier. Use the production directory and work stores
  // with the scheduler stopped, so it cannot compete with the test employee's lease.
  assert.ok(changeState('resume').ok);
  try {
    const projectService = createProjects({
      records,
      store,
      work,
      git: createLocalProjectGit({ directory: join(dataDir, 'projects.git') }),
    });
    const { task } = await work.execute('owner', 'task.create', {
      requestId: randomUUID(),
      goalId: project.goalId,
      assigneeId: employeeId,
      title: 'Prepare service bulletin',
      acceptance: 'A tested source handoff.',
    });
    const { claimToken } = await work.execute(employeeId, 'task.claim', {
      taskId: task.id,
      requestId: randomUUID(),
    });
    const files = [
      { path: 'public/index.html', content: '<main>Verified service bulletin</main>' },
      { path: 'public/app.mjs', content: 'export const total=a=>a.length;' },
      {
        path: 'test/app.test.mjs',
        content:
          "import test from 'node:test'; import assert from 'node:assert/strict'; import {total} from '../public/app.mjs'; test('counts bulletins',()=>assert.strictEqual(total(['one']),1));",
      },
    ];
    const { handoff } = await projectService.execute(employeeId, 'project.commit', {
      projectId: project.id,
      taskId: task.id,
      files,
      requestId: randomUUID(),
    });
    assert.equal(handoff.pr.local, true);
    await work.execute(employeeId, 'task.submit', {
      taskId: task.id,
      claimToken,
      evidence: ['Committed ' + handoff.sha],
      requestId: randomUUID(),
    });
    await work.execute('owner', 'task.review', {
      taskId: task.id,
      decision: 'accept',
      note: 'Source and handoff accepted.',
      requestId: randomUUID(),
    });
  } finally {
    assert.ok(changeState('pause').ok);
  }
}

export async function checkHandoffAndPromotion({ page, nav, project, employeeId }) {
  await nav(page, 'projects');
  await page
    .getByRole('button', { name: new RegExp(projectName) })
    .first()
    .click();
  await heading(page, projectName);
  await dialog(page)
    .getByRole('button', { name: /[a-f0-9]{12}/ })
    .click();
  await heading(page, 'Source handoff');
  await dialog(page)
    .getByText(/^Local PR /)
    .waitFor();
  await dialog(page).getByRole('button', { name: 'public/index.html' }).click();
  await dialog(page).getByText('<main>Verified service bulletin</main>', { exact: true }).waitFor();
  await button(page, 'Back to handoff').click();
  await heading(page, 'Source handoff');
  if (process.env.PEROTTINO_UI_DELIVERY === '1') {
    await button(page, 'Build and test').click();
    await button(page, 'Run build').click();
    await button(page, 'Create preview').click();
    await page.getByLabel('Lifetime (hours)').fill('1');
    await dialog(page).getByRole('button', { name: 'Create preview', exact: true }).click();
    const preview = await dialog(page).getByRole('link', { name: 'Open preview' }).getAttribute('href');
    assert.match(await (await fetch(preview)).text(), /Verified service bulletin/);
    await button(page, 'Release build').click();
    await button(page, 'Publish release').click();
    const production = await dialog(page).getByRole('link', { name: 'Open release' }).getAttribute('href');
    assert.match(await (await fetch(production)).text(), /Verified service bulletin/);
    await button(page, 'Remove preview').click();
    await button(page, 'Confirm removal').click();
    await button(page, 'Withdraw production release').click();
    await button(page, 'Confirm withdrawal').click();
    await dialog(page).getByRole('link', { name: 'Open release' }).waitFor({ state: 'hidden' });
    assert.equal((await fetch(production)).status, 404);
  }
  await close(page);
  await nav(page, 'settings');
  await button(page, 'Promotions').click();
  await button(page, 'Propose promotion').click();
  await page.getByLabel('Employee', { exact: true }).selectOption(employeeId);
  await button(page, 'Continue').click();
  await page.getByRole('checkbox', { name: 'Prepare service bulletin' }).check();
  await page.getByLabel('First hire case').fill('A QA engineer can verify the release.');
  await page.getByLabel('Project ID').fill(project.id);
  await page.getByLabel('Permitted roles, separated by commas').fill('QA engineer');
  await page.getByLabel('Direct report limit').fill('1');
  await page.getByLabel('Allocation ceiling (USD)').fill('2.00');
  await button(page, 'Submit proposal').click();
  await page.getByRole('button', { name: /A QA engineer can verify/ }).click();
  await button(page, 'Approve promotion').click();
  await button(page, 'Confirm approval').click();
  await page.getByText('Approved', { exact: true }).waitFor();
}

export async function checkBrowserControl({ page, nav }) {
  await nav(page, 'browsers');
  await page.getByLabel('Employee browsers').selectOption('ceo');
  await button(page, 'Grant profile').click();
  await dialog(page).getByRole('button', { name: 'Grant profile', exact: true }).click();
  await page.locator('#content').getByText('Offline smoke', { exact: true }).waitFor();
  await button(page, 'Start browser').click();
  await page.getByLabel('Browser profile').selectOption('smokelocal-0123456789');
  await button(page, 'Start session').click();
  await dialog(page).getByRole('img').waitFor({ timeout: 30000 });
  const sessionPath = await dialog(page)
    .getByRole('link', { name: 'Link to this session' })
    .getAttribute('href');
  assert.match(sessionPath, /^\/chat#browsers\?sessionId=bs-[a-f0-9]{32}$/);
  assert.equal((await fetch(new URL(sessionPath, page.url()))).status, 401);
  await page.goto(sessionPath);
  await dialog(page).getByRole('img').waitFor();
  await button(page, 'Take control').click();
  await page.getByText('You have control.', { exact: true }).waitFor();
  await dialog(page)
    .getByRole('img')
    .click({ position: { x: 20, y: 20 } });
  await page.getByLabel('Browser key').selectOption('Enter');
  await button(page, 'Send key').click();
  await button(page, 'Hand back control').click();
  await page.getByText('Employee has control.', { exact: true }).waitFor();

  // Keep Chromium's own authenticated request. Delay delivery of one real
  // response to the portal, then observe when the portal sends its stop.
  await page.evaluate(() => {
    const original = window.fetch;
    const gate = Promise.withResolvers();
    const probe = window.browserStopProbe = { held: false, order: [], release: gate.resolve,
      restore() { window.fetch = original; delete window.browserStopProbe; } };
    window.fetch = async (...args) => {
      const path = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href).pathname;
      if (path === '/api/company/browser.stop') probe.order.push('stop');
      const response = await original.apply(window, args);
      if (path === '/api/company/browser.frame' && response.ok && !probe.held) {
        probe.held = true;
        await gate.promise;
        probe.order.push('frame');
      }
      return response;
    };
  });
  try {
    await button(page, 'Refresh view').click();
    await page.waitForFunction(() => window.browserStopProbe.held, undefined, { timeout: 15000 });
    await button(page, 'Stop session').click();
    await dialog(page).getByRole('button', { name: 'Stop session', exact: true }).click();
    await page.evaluate(() => window.browserStopProbe.release());
    await page.getByText('Stopped', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.browserStopProbe.order), ['frame', 'stop']);
  } finally {
    await page.evaluate(() => {
      window.browserStopProbe.release();
      window.browserStopProbe.restore();
    });
  }
  await button(page, 'Revoke profile').click();
  await button(page, 'Revoke access').click();
  await page.getByText('No profiles assigned.', { exact: true }).waitFor();
}
