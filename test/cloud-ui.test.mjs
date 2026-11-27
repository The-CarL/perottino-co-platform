import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { hashPassword } from '../src/auth.mjs';
import { createCloudHandler } from '../src/cloud-api.mjs';

test('owner browser loads older pages, opens a historical source and keeps loaded history through refresh', async t => {
  const origin = 'https://owner.example.test';
  const secret = 'synthetic password for the paging UI test';
  const passwordHash = await hashPassword(secret);
  const agent = { id: 'ceo', handle: 'mara', name: 'Mara', role: 'CEO' };
  const sent = (id, text, day) => ({ id, text, author: 'owner', createdAt: '2026-11-' + day + 'T13:00:00.000Z' });
  const recent = sent('most-recent', 'This is the latest turn.', '26');
  const earlier = sent('prior-page', 'This turn is one page back.', '24');
  const source = sent('historical-source', 'Original statement from an older page.', '20');
  const memory = (id, text, message) => ({ id, text, sourceMessageId: message.id, createdAt: message.createdAt });
  const memoCursor = 'NOTE#2026-11-26T13:00:00.000Z#new-note';
  const turnCursor = 'TURN#0000000000000002';
  let oldNote = memory('old-note', 'Older note', source);
  let newMessages = [];
  const reads = [];
  const handle = createCloudHandler({ publicOrigin: origin, readOwner: async () => ({ username: 'owner', passwordHash }),
    store: {
      directory: async () => [agent,{ id:'iris',name:'Iris',handle:'iris',role:'Engineer' }], getAgent: async id => id === agent.id ? agent : null,
      async messagePage(_id, cursor) {
        reads.push(['turns', cursor]);
        if (cursor === undefined) return { messages: [recent,...newMessages], status: 'idle', nextCursor: turnCursor };
        assert.equal(cursor, turnCursor);
        return { messages: [earlier], status: 'idle' };
      },
      async memoryPage(_id, cursor) {
        reads.push(['notes', cursor]);
        if (cursor === undefined) return { memories: [memory('new-note', 'Current note', recent)], nextCursor: memoCursor };
        assert.equal(cursor, memoCursor);
        return { memories: oldNote ? [oldNote] : [] };
      },
      async messageSource(_id, id) { reads.push(['source', id]); return id === source.id ? source : null; },
      async changeMemory(_id, id, method, _requestId, text) {
        if (id !== oldNote?.id) return 'missing';
        oldNote = method === 'PATCH' ? { ...oldNote, text, updatedBy: 'owner' } : null;
        return 'ok';
      },
    } });
  const browser = await chromium.launch({ executablePath: process.env.PEROTTINO_CHROMIUM_PATH || undefined, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 },
    extraHTTPHeaders: { authorization: 'Basic ' + Buffer.from('owner:' + secret).toString('base64') } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Route the complete HTTPS request through the shipping Lambda handler. No external DNS, AWS service or socket.
  await page.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) { await route.abort(); return; }
    const response = await handle({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), body: req.postData(),
      headers: { ...await req.allHeaders(), host: url.hostname },
      requestContext: { domainName: url.hostname, http: { method: req.method(), sourceIp: '192.0.2.1' } } });
    await route.fulfill({ status: response.statusCode, headers: response.headers, body: response.body });
  });
  await page.goto(origin + '/chat');
  const timeline = page.locator('#timeline');
  await timeline.getByText(recent.text, { exact: true }).waitFor();
  await page.locator('#earlierMessages').click();
  await timeline.getByText(earlier.text, { exact: true }).waitFor();
  assert.deepEqual(await timeline.locator('.bubble').allTextContents(), [earlier.text, recent.text]);
  await page.locator('#memoryButton').click();
  await page.locator('#moreNotes').click();
  const old = page.locator('#memories .memory-note').filter({ hasText: 'Older note' });
  await old.getByRole('button', { name: 'Source message' }).click();
  await page.locator('#sourceDialog').waitFor();
  await page.waitForFunction(expected => document.querySelector('#sourceBody')?.textContent.includes(expected), source.text);
  await page.keyboard.press('Escape');
  const refreshed = page.waitForResponse(r => r.url() === origin + '/api/agents/ceo/messages');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
  await old.waitFor();
  assert.deepEqual(await timeline.locator('.bubble').allTextContents(), [earlier.text, recent.text]);
  await old.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Note', { exact: true }).fill('Owner-corrected historical note');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const corrected = page.locator('#memories .memory-note').filter({ hasText: 'Owner-corrected historical note' });
  await corrected.waitFor();
  assert.equal(oldNote.text, 'Owner-corrected historical note');
  await corrected.getByRole('button', { name: 'Forget', exact: true }).click();
  await page.getByRole('button', { name: 'Forget note', exact: true }).click();
  await corrected.waitFor({ state: 'detached' });
  assert.equal(oldNote, null);
  assert.ok(reads.some(([op, key]) => op === 'source' && key === source.id));
  newMessages = [{ ...sent('email','A public question','27'), author:'external',email:{from:'reader@example.test',subject:'Preview availability'} },
    { ...sent('coworker','Review is ready','27'), author:'employee',senderAgentId:'iris'}];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await timeline.getByText('Email from reader@example.test',{exact:true}).waitFor();
  await timeline.getByText('Preview availability',{exact:true}).waitFor();
  await timeline.locator('#message-coworker').getByText('Iris',{exact:true}).waitFor();
  assert.deepEqual(errors, []);
});
