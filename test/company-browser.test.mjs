import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createManagedBrowser} from '../src/company-browser.mjs';
import {localInteractiveBrowser} from '../src/interactive-browser.mjs';
import {makeSqliteRecords} from '../src/foundation-records.mjs';
import {createCompanyFiles,localBlobs} from '../src/company-files.mjs';
async function fixture(t,provider,profiles) {
  const root=await mkdtemp(join(tmpdir(),'company-browser-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const records=makeSqliteRecords({filename:':memory:'});t.after(()=>records.close());
  const employee=async id=>['ceo','eng'].includes(id)?{id,name:id,handle:id,role:'Employee'}:null;
  const files=createCompanyFiles({records,blobs:localBlobs(join(root,'files')),employee});
  const service=createManagedBrowser({records,employee,provider,profiles,files});
  return {invoke:(actor,op,args={})=>service.execute(actor,'browser.'+op,{requestId:randomUUID(),...args}),files};
}
test('live Chromium takeover, passive public pages, active dedicated preview, file import and screenshot',async t=>{
  const root=await mkdtemp(join(tmpdir(),'browser-pw-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const old=process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX='1';
  t.after(()=>{if(old===undefined)delete process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX;else process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX=old;});
  const web=createServer((req,res)=>{
    if(req.url==='/report.csv'){res.writeHead(200,{'content-type':'text/csv'}).end('observed,42');return;}
    res.writeHead(200,{'content-type':'text/html'}).end('<title>Forecast</title><div id="value">passive</div><script>document.querySelector("#value").textContent="verified JS"</script><input>');
  });
  web.listen(0,'127.0.0.1');await once(web,'listening');t.after(()=>new Promise(r=>web.close(r)));
  const origin='http://127.0.0.1:'+web.address().port;
  const provider=localInteractiveBrowser({dataDir:root,fixtureOrigin:origin,deliveryOrigin:origin});t.after(()=>provider.close());
  const {invoke,files}=await fixture(t,provider,[]);
  const start={requestId:randomUUID(),url:origin+'/ordinary'}, {session}=await invoke('eng','start',start),s={sessionId:session.id};
  assert.equal((await invoke('eng','start',start)).session.id,session.id);
  assert.equal((await invoke('eng','read',s)).text,'passive');
  assert.equal((await invoke('owner','list')).sessions[0].employeeId,'eng');
  await assert.rejects(invoke('ceo','read',s),{status:404});await assert.rejects(invoke('eng','frame',s),{status:403});
  const url=origin+'/v/p-'+'1'.repeat(32)+'/b-'+'2'.repeat(32)+'/';
  await invoke('eng','navigate',{...s,url});assert.match((await invoke('eng','read',s)).text,/verified JS/);
  await invoke('owner','takeover',s);
  await assert.rejects(invoke('eng','input',{...s,kind:'type',text:'stale'}),{status:409});
  const frame=await invoke('owner','frame',s);
  assert.match(frame.dataUrl,/^data:image\/jpeg;base64,/);assert.equal(frame.width,1280);
  await invoke('owner','input',{...s,kind:'key',key:'Tab'});await invoke('owner','input',{...s,kind:'type',text:'entered'});
  await invoke('owner','release',s);
  await assert.rejects(invoke('owner','input',{...s,kind:'key',key:'Enter'}),{status:409});
  assert.equal((await invoke('eng','screenshot',{...s,path:'reports/verified.jpg'})).file.version,1);
  await invoke('eng','download',{...s,url:origin+'/report.csv',path:'reports/input.csv'});
  const saved=await files.execute('eng','files.read',{path:'reports/input.csv'});
  assert.equal(Buffer.from(saved.file.contentBase64,'base64').toString(),'observed,42');
  await assert.rejects(invoke('eng','navigate',{...s,url:'http://169.254.169.254/latest/meta-data'}),/public web/);
  await invoke('eng','stop',s);assert.equal((await invoke('owner','list')).sessions[0].status,'stopped');
});
test('configured origin grants, exclusive profile, transfer and revocation',async t=>{
  let inputs=0,published=0;
  const provider={validate:async(url,origins)=>{if(!origins?.includes(new URL(url).origin))throw Object.assign(Error('origin'),{status:403});},
    start:async s=>s.id,action:async()=>{inputs++;return {ok:true};},stop:async()=>{},save:async()=>{published++;}};
  const profile={id:'expense-1234567890',label:'Expenses',origins:['https://example.org']};
  const {invoke}=await fixture(t,provider,[profile]);const assign={profileId:profile.id,employeeId:'eng'};
  await assert.rejects(invoke('eng','profile.grant',assign),{status:403});
  await invoke('owner','profile.grant',assign);await invoke('owner','profile.grant',{...assign,employeeId:'ceo'});
  const s={sessionId:(await invoke('eng','start',{profileId:profile.id,url:'https://example.org/bill'})).session.id};
  assert.equal((await invoke('owner','view',s)).path,'/chat#browsers?sessionId='+s.sessionId);
  await assert.rejects(invoke('ceo','start',{profileId:profile.id}),{status:409});
  await assert.rejects(invoke('eng','navigate',{...s,url:'https://another.example/bill'}),{status:403});
  const replay={...s,kind:'key',key:'Enter',requestId:randomUUID()};
  await invoke('eng','input',replay);await invoke('eng','input',replay);assert.equal(inputs,1);
  await assert.rejects(invoke('eng','stop',{...s,saveProfile:true}),{status:403});assert.equal(published,0);
  await invoke('owner','profile.revoke',assign);await assert.rejects(invoke('eng','read',s),{status:403});
  await invoke('owner','profile.grant',assign);
  await assert.rejects(invoke('eng','read',s),{status:403});
  await invoke('owner','stop',s);
  const {session:fresh}=await invoke('ceo','start',{profileId:profile.id});
  await invoke('owner','stop',{sessionId:fresh.id,saveProfile:true});assert.equal(published,1);
});
