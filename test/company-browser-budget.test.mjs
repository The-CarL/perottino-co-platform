import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {makeAgentCoreBrowser} from '../src/agentcore-browser.mjs';
import {hostedAdapters} from '../src/company-adapters.mjs';
import {createBrowserBudget} from '../src/company-browser-budget.mjs';
import {createManagedBrowser} from '../src/company-browser.mjs';
import {makeSqliteRecords} from '../src/foundation-records.mjs';

function database(t) {
  const records = makeSqliteRecords({filename:':memory:'});
  t.after(()=>records.close());
  return records;
}

test('owner interactive session and employee document reads share the allowance, including early stop', async t => {
  const records = database(t);
  const budget = createBrowserBudget({records,minutes:17});
  const starts = [];
  const employee = async id => ({id});
  const provider = {
    async start(row) { starts.push('interactive'); return row.id; },
    async stop() {},
  };
  const managed = createManagedBrowser({records,employee,provider,budget});
  const args = {requestId:'first'};
  const first = await managed.execute('owner','browser.start',args);
  assert.deepEqual(await managed.execute('owner','browser.start',args), first);
  await managed.execute('owner','browser.stop',{requestId:'stop',sessionId:first.session.id});
  assert.equal((await budget.usage()).reservedSeconds,900);

  const server = createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<p>Sample</p>'));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const control = async () => ({
    async start(signal, options) {
      signal.throwIfAborted();
      assert.match(options.clientToken,/^[0-9a-f]{64}$/);
      assert.equal(options.timeoutSeconds,90);
      starts.push('document');
      return 'synthetic';
    },
    async connect() { return {close:async()=>{}}; },
    async stop(){}, close(){},
  });
  const reader = requestId => makeAgentCoreBrowser({control,fixtureOrigin:origin,read:async()=>({title:'Sample',text:'hello'}),
    admit:()=>budget.reserve('engineer','document',requestId)});
  assert.equal((await reader('document-1')(origin)).text,'hello');
  await assert.rejects(reader('document-1')(origin),{code:'BROWSER_ADMISSION_USED'});
  await assert.rejects(reader('document-2')(origin),{status:429,code:'BROWSER_ALLOWANCE_EXHAUSTED'});
  await assert.rejects(managed.execute('engineer','browser.start',{requestId:'new'}),{status:429});
  assert.equal((await records.list('browser-sessions')).items.length,1);
  assert.deepEqual(starts,['interactive','document']);
  assert.equal((await budget.usage()).remainingSeconds,30);
});

test('overlapping sessions consume both UTC months, use one receipt, and competing reservations fit the cap', async t => {
  const records = database(t);
  let time = Date.parse('2026-01-31T23:59:59Z');
  const options = {minutes:15,records,now:()=>time};
  const budget = createBrowserBudget(options);
  const permit = await budget.reserve('ceo','interactive','first');
  assert.equal(permit.startToken(),'first');
  time = Date.parse('2026-02-01T00:02:00Z');
  const restarted = createBrowserBudget(options);
  assert.equal((await restarted.usage()).reservedSeconds,900);
  assert.throws(()=>permit.startToken(),{code:'BROWSER_ADMISSION_EXPIRED'});
  const replay = await restarted.reserve('ceo','interactive','first');
  assert.throws(()=>replay.startToken(),{code:'BROWSER_ADMISSION_EXPIRED'});
  await assert.rejects(restarted.reserve('owner','document','next'),{status:429});
  time = Date.parse('2026-03-01T00:00:05Z');
  const small = createBrowserBudget({...options,minutes:2});
  const pair = await Promise.allSettled(['owner','eng'].map(actor=>small.reserve(actor,'document','case')));
  assert.equal(pair.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(pair.find(r=>r.status==='rejected').reason.code,'BROWSER_ALLOWANCE_EXHAUSTED');
  assert.equal((await small.usage()).remainingSeconds,30);
});

test('failed or uncertain provider calls consume the hold and malformed accounting denies fresh admission', async t => {
  const records = database(t);
  let time = Date.parse('2026-01-15T12:00:00Z');
  const budget = createBrowserBudget({records,minutes:15,now:()=>time});
  const starts = [];
  const provider = {async start(session, permit) {
    starts.push(permit.startToken());
    if (starts.length === 1) throw Error('lost response');
    assert.equal(permit.startToken(),session.id);
    return 'recovered-session';
  }};
  const create = () => createManagedBrowser({records,employee:async id=>({id}),budget,now:()=>time,provider});
  await assert.rejects(create().execute('ceo','browser.start',{requestId:'lost'}),/lost response/);
  time += 5_000;
  const {session}=await create().execute('ceo','browser.start',{requestId:'lost'});
  assert.equal(session.status,'active');
  assert.deepEqual(starts,[session.id,session.id]);
  assert.equal((await budget.usage()).reservedSeconds,900);
  time = Date.parse('2026-02-15T00:00:00Z');
  await records.transact([{pk:'browser:monthly-allowance',sk:'2026-02',expect:null,value:{reservedSeconds:-5}}]);
  await assert.rejects(budget.reserve('ceo','document','new'),{status:503});
  const zero = createBrowserBudget({records,minutes:0,now:()=>Date.parse('2026-05-15T12:00:00Z')});
  await assert.rejects(zero.reserve('owner','document','new'),{status:429});
});

test('hosted owner can read remaining allowance before any sessions and employees cannot change it', async t => {
  const records = database(t);
  const service = hostedAdapters({PEROTTINO_BROWSER_MONTHLY_MINUTES:'200'}).browser({records});
  assert.equal((await service.execute('owner','browser.usage',{})).remainingSeconds,12000);
  await assert.rejects(service.execute('ceo','browser.usage',{}),{status:403});
  assert.throws(()=>hostedAdapters({PEROTTINO_BROWSER_MONTHLY_MINUTES:'invalid'}),/Invalid monthly/);
});
