import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { hashPassword } from '../src/auth.mjs';
import { createCloudHandler } from '../src/cloud-api.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { createCompanyService } from '../src/company-service.mjs';

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
  await page.locator('#nav-chat').click();
  await page.locator('#timeline').getByText('Owner conversation',{exact:true}).waitFor();
  assert.equal(await page.getByText('Private team discussion').count(),0);
  assert.deepEqual(errors,[]);
});
