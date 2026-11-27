import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { hashPassword } from '../src/auth.mjs';
import { createCloudHandler } from '../src/cloud-api.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { createCompanyService } from '../src/company-service.mjs';
import { eventRows } from '../src/company-events.mjs';

test('shipping Gateway handler scopes Chat to the owner and audits explicit read-only Admin inspection',async t => {
  const origin = 'https://owner.example.test';
  const password = 'synthetic portal test credentials';
  const passwordHash = await hashPassword(password);
  const records = makeSqliteRecords({filename:':memory:'});
  t.after(() => records.close());
  const people = [
    {id:'ceo',handle:'mara',name:'Mara',role:'CEO',managerId:null,desiredState:'active'},
    {id:'kai',handle:'kai',name:'Kai Costa',role:'Engineer',managerId:'ceo',desiredState:'active'},
  ];
  const company = createCompanyService({records,store:{listEmployees:()=>people, employee:id=>people.find(p=>p.id===id)}});
  const command = (actor,op,input) => company.execute(actor,op,input);
  const mara = (await command('owner','conversations.dm',{peerId:'ceo'})).conversation;
  const kai = (await command('ceo','conversations.dm',{peerId:'kai'})).conversation;
  await command('owner','messages.post',{conversationId:mara.id,text:'Owner conversation',requestId:'own'});
  const message = (await command('ceo','messages.post',{conversationId:kai.id,text:'Private team discussion',requestId:'private'})).message;
  await command('kai','memory.save',{conversationId:kai.id,sourceMessageId:message.id,text:'Team context',requestId:'remember'});
  await assert.rejects(command('owner','memory.list',{conversationId:kai.id,employeeId:'kai'}),{status:404});
  const { goal } = await command('owner', 'goal.create', {
    outcome:'Audit the reporting change', successCriteria:'Reviewed deliverable', accountableId:'ceo',requestId:'ui-goal',
  });
  const { task } = await command('owner', 'task.create', {
    goalId:goal.id, title:'Reconcile the ledger', acceptance:'Evidence recorded', assigneeId:'kai',requestId:'ui-task',
  });
  const auditEvents = [
    ['budget.settle', {employeeId:'kai', policyVersion:3, projectId:'p-9', fundingGrantId:'g-2',
      amountKind:'spend', amountCents:125, purpose:'model', taskId:task.id}],
    ['delivery.build', {projectId:'p-9', buildId:'b-8', taskId:task.id, status:'passed'}],
    ['infra.active', {projectId:'p-9', resourceId:'i-7', status:'active'}],
    ['browser.started', {browserSessionId:'bs-6', browserProfileId:'profile-5', status:'active'}],
    ['mail.sent', {threadId:'th-4', messageId:'m-3', subject:'Excluded subject'}],
  ];
  for (const [kind, metadata] of auditEvents) {
    assert(await records.transact(eventRows(kind, {actor:'ceo', ...metadata}, 'ui-audit-'+kind)));
  }
  const handle = createCloudHandler({company,publicOrigin:origin,readOwner:async()=>({username:'owner',passwordHash})});
  const browser = await chromium.launch({executablePath:process.env.PEROTTINO_CHROMIUM_PATH || undefined});
  t.after(()=>browser.close());
  const auth = 'Basic ' + Buffer.from('owner:'+password).toString('base64');
  const page = await browser.newPage({extraHTTPHeaders:{authorization:auth}});
  const errors = [];
  page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',async route=>{
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const result = await handle({version:'2.0',rawPath:url.pathname,rawQueryString:url.search.slice(1),body:req.postData(),
      headers:{...await req.allHeaders(),host:url.hostname},requestContext:{domainName:url.hostname,http:{method:req.method(),sourceIp:'192.0.2.1'}}});
    await route.fulfill({status:result.statusCode,headers:result.headers,body:result.body});
  });
  await page.goto(origin+'/chat');
  await page.locator('#timeline').getByText('Owner conversation',{exact:true}).waitFor();
  assert.equal(await page.getByText('Private team discussion').count(),0);
  assert.equal(await page.locator('[data-conversation-id="'+kai.id+'"]').count(),0);
  assert.equal((await records.list('company-events')).items.some(e=>e.kind.startsWith('admin.')),false);
  const denied = await page.evaluate(async id => {
    const options={method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'owner-console'},body:JSON.stringify({conversationId:id})};
    return [(await fetch('/api/company/messages.list',options)).status,(await fetch('/api/agents/kai/messages')).status];
  },kai.id);
  assert.deepEqual(denied,[404,404]);
  await page.locator('#nav-admin').click();
  await page.locator('[data-conversation-id="'+kai.id+'"]').click();
  await page.locator('#timeline').getByText('Private team discussion',{exact:true}).waitFor();
  assert.equal(await page.locator('#composer').count(),0);
  const audits = (await records.list('company-events')).items.filter(e=>e.kind.startsWith('admin.'));
  assert.ok(audits.some(e=>e.kind==='admin.messages.read' && e.actor==='owner' && e.conversationId===kai.id));
  assert.doesNotMatch(JSON.stringify(audits),/Private team discussion|Team context/);
  await page.getByRole('button',{name:'Audit log'}).click();
  const audit = page.locator('#dialog');
  async function inspectEvent(name, labels, values) {
    const row = audit.locator('.event').filter({has:page.getByText(name,{exact:true})});
    await row.getByText('Audit details',{exact:true}).click();
    for (const title of labels) await row.getByText(title,{exact:true}).waitFor();
    for (const value of values) await row.getByText(value,{exact:true}).waitFor();
    return row;
  }
  await inspectEvent('Delivery build',['Build ID'],['b-8']);
  await inspectEvent('Infra active',['Resource ID'],['i-7']);
  await inspectEvent('Browser started',['Browser session ID','Browser profile ID'],['bs-6','profile-5']);
  await inspectEvent('Mail sent',['Email thread ID','Message ID'],['th-4','m-3']);
  assert.doesNotMatch(await audit.innerText(),/Private team discussion|Team context|Excluded subject/);
  const spending = await inspectEvent('Budget settle',['Policy revision','Project ID','Funding grant','Amount type','Amount (USD)','Purpose'],
    ['3','p-9','g-2','Spend','$1.25','Model']);
  await spending.getByRole('button',{name:'Open task'}).click();
  await audit.getByRole('heading',{name:'Reconcile the ledger'}).waitFor();
  await page.locator('#dialog-close').click();
  await page.locator('#nav-activity').click();
  await page.locator('#content').getByText('Delivery build',{exact:true}).waitFor();
  const headline = await page.locator('#content').innerText();
  assert.doesNotMatch(headline,/bs-6|th-4|profile-5|Private team discussion|Excluded subject|Audit details/);
  await page.locator('#nav-chat').click();
  await page.locator('#timeline').getByText('Owner conversation',{exact:true}).waitFor();
  assert.equal(await page.getByText('Private team discussion').count(),0);
  assert.deepEqual(errors,[]);
});
