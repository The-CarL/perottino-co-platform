import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function checkPortalFileLinks({ page, nav, api, employeeId }) {
  const path = 'projects/bulletins/Notes & approval.md';
  const original = 'The first, reviewed contents.';
  const button = (root, name) => root.getByRole('button', { name, exact: true });
  const modal = page.locator('#dialog');
  const pinned = path + ' · v1';
  for (const [index, text] of [original, 'This is a later edit.'].entries()) {
    await api('files.write', { path, text, expectedVersion: index, requestId: randomUUID() });
  }

  async function insert(root, draft) {
    await root.getByText('Link a company file', { exact: true }).click();
    await root.getByLabel('Company file path').fill(path);
    await root.getByLabel('File version (optional)').fill('1');
    await button(root, 'Insert version link').click();
    await root.locator('details[open]').waitFor({ state: 'hidden' });
    const value = await draft.inputValue();
    const link = new URL(value.trim().split(/\s+/).at(-1));
    assert.equal(link.origin, new URL(page.url()).origin);
    assert.equal(new URLSearchParams(link.hash.slice('#files?'.length)).get('version'), '1');
    return link.href;
  }
  async function openPinned(root) {
    await root.getByRole('link', { name: pinned, exact: true }).first().click();
    await modal.getByText(original, { exact: true }).waitFor();
    await button(page, 'Close dialog').click();
  }

  await nav(page, 'directory');
  await page.locator('#directory-search').fill('@ceo');
  await button(page, 'Message Mara').click();
  const composer = page.locator('#composer'),
    draft = composer.locator('textarea');
  await draft.fill('Approved handoff');
  const link = await insert(composer, draft);
  await button(composer, 'Send message').click();
  await openPinned(page.locator('#timeline .own'));
  assert.equal((await fetch(link)).status, 401);
  const request = await fetch(new URL('/api/company/files.read', link), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'owner-console' },
    body: JSON.stringify({ path, version: 1 }),
  });
  assert.equal(request.status, 401);

  const { agents } = await api('directory');
  const target = agents.find((employee) => employee.id === employeeId);
  assert.ok(target);
  const { domain } = await api('mail.list', { limit: 1 });
  await nav(page, 'mail');
  await button(page, 'Compose email').click();
  await modal.getByLabel('Send as').selectOption('ceo');
  await modal.getByLabel('To', { exact: true }).fill('external@example.test');
  assert.ok(await modal.getByText('Link a company file', { exact: true }).isHidden());
  await modal.getByLabel('To', { exact: true }).fill(target.handle + '@' + domain);
  await modal.getByLabel('Subject', { exact: true }).fill('Document for internal approval');
  const body = modal.getByLabel('Email message');
  await body.fill('Please review');
  assert.equal(await insert(modal, body), link);
  await button(modal, 'Send email').click();
  await openPinned(modal);
}
