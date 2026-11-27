// Synthetic founder and deterministic employees for the local acceptance test.
// The resident scheduler, mail ingress, Git, sandbox, public listener and persistence are the application.
import {join} from 'node:path';
import {createApp} from '../../src/server.mjs';
import {createStore} from '../../src/store.mjs';
import {makeSqliteRecords} from '../../src/foundation-records.mjs';
import {createCompanyMail} from '../../src/company-mail.mjs';
import {createEmailIngress} from '../../src/email-ingress.mjs';
import {hashPassword} from '../../src/auth.mjs';

const offset = Number(process.argv[3]);
if (offset) {
  const Clock = Date;
  globalThis.Date = class extends Clock {
    constructor(...args) { super(...(args.length ? args : [Clock.now()+offset])); }
    static now() { return Clock.now()+offset; }
  };
}
const dataDir = process.argv[2], domain = 'company.invalid';
const topicArn = 'local:synthetic-mail', token = 'a'.repeat(52), founder = 'founder@example.invalid';
const handoffPath = 'projects/country-sample/registry.json', sourcePath = 'projects/country-sample/release.json';
const action = (op,input={}) => ({op,input});
const taskTitle = change => change ? 'Add the American region to the app.' : 'Publish the country code app.';
const criteria = 'Provide a passing build and a reachable temporary preview of the country codes.';
const note = 'Keep stable ISO alpha-2 identifiers when adding a display region.';
function decide(ctx) {
  const steps = ctx.steps;
  for (const s of steps) if (s.result?.error) throw Error(s.op+' rejected: '+s.result.error);
  if (ctx.kind === 'mail') {
    if (!ctx.trustedOwner) return action('pass');
    const change = ctx.message.text.includes('region');
    const engineer = ctx.directory.find(e=>e.role === 'Engineer');
    if (!steps.length) return action('goal.create',{outcome:taskTitle(change),successCriteria:criteria});
    const goalId = steps[0].result.goal.id;
    if (change) {
      if (steps.length === 1) return action('files.read',{path:handoffPath});
      if (steps.length === 2) return action('project.attach',{goalId,projectId:JSON.parse(steps[1].result.file.text).projectId});
      if (steps.length === 3) return action('task.create',{goalId,assigneeId:engineer.id,title:taskTitle(true),acceptance:criteria});
    } else if (steps.length === 1) return action('employee.hire',{role:'Engineer',goalId,allocationCents:8,
      title:taskTitle(false),acceptance:criteria});
    return action('pass');
  }
  if (ctx.kind === 'review') {
    const [url,sha,projectId] = ctx.task.evidence;
    if (!steps.length) return action('delivery.status',{projectId,taskId:ctx.task.id,commitSha:sha});
    const {build,preview} = steps[0].result;
    if (build.status !== 'passed' || build.testsPassed < 1 || preview.url !== url || preview.commitSha !== sha) throw Error('Unverifiable delivery');
    return action('task.review',{decision:'accept',note:'Verified the passing build, exact source commit and published preview.'});
  }
  if (ctx.kind === 'close') return action('goal.close',{requesterReply:'The app is ready. '+ctx.results[0].evidence[0]});
  if (ctx.kind === 'plan') throw Error('The brief must carry the initial task.');
  if (ctx.kind !== 'task') return action('pass');
  const change = ctx.task.title === taskTitle(true);
  if (ctx.task.workStep === 0) {
    if (!change) {
      if (!steps.length) return action('project.create',{name:'Country codes'});
      const projectId = steps[0].result.project.id;
      if (steps.length === 1) return action('files.write',{path:handoffPath,text:JSON.stringify({projectId,source:'ISO 3166-1: CA, US'}),expectedVersion:0});
      if (steps.length === 2) return action('knowledge.save',{projectId,text:note});
      if (steps.length === 3) return action('mail.send',{to:'mara@'+domain,subject:'Country data handoff',text:'The source registry and ISO code decision are recorded.'});
      return action('task.progress',{note:JSON.stringify({projectId,baseSha:null})});
    }
    if (!steps.length) return action('files.read',{path:handoffPath});
    const projectId = JSON.parse(steps[0].result.file.text).projectId;
    if (steps.length === 1) return action('knowledge.list',{projectId});
    if (!steps[1].result.memories.some(m=>m.text===note)) throw Error('Durable source decision missing');
    if (steps.length === 2) return action('project.history',{projectId});
    const prior = steps[2].result.handoffs[0];
    if (steps.length === 3) return action('project.snapshot',{projectId,taskId:prior.taskId,commitSha:prior.sha,path:'public/index.html'});
    if (!steps[3].result.content.includes('Country codes')) throw Error('Previous source revision unavailable');
    return action('task.progress',{note:JSON.stringify({projectId,baseSha:prior.sha})});
  }
  const {projectId,baseSha} = JSON.parse(ctx.task.progress);
  if (!steps.length) {
    const countries = change ? [['CA','Americas'],['US','Americas']] : [['CA'],['US']];
    const files = [
      {path:'public/index.html',content:'<!doctype html><title>Country codes</title><h1>Country codes</h1><p>'+countries.map(c=>c.join(' / ')).join(', ')+'</p>'},
      {path:'codes.mjs',content:'export default '+JSON.stringify(countries)+';'},
      {path:'test/codes.test.mjs',content:"import test from 'node:test'; import assert from 'node:assert/strict'; import rows from '../codes.mjs'; test('official codes',()=>assert.deepEqual(rows,"+JSON.stringify(countries)+'));'},
    ];
    if (!change) files.push({path:'README.md',content:'Public reference sample from ISO 3166-1.'});
    return action('project.commit',{projectId,...(baseSha && {baseSha}),files});
  }
  const handoff = steps[0].result.handoff;
  if (steps.length === 1) return action('delivery.build',{projectId,commitSha:handoff.sha});
  const build = steps[1].result;
  if (build.status !== 'passed') throw Error('Build did not pass, reason '+build.reason);
  if (steps.length === 2) return action('delivery.preview',{projectId,buildId:build.buildId,ttlHours:12});
  const url = steps[2].result.url;
  if (steps.length === 3) return action('files.write',{path:sourcePath,expectedVersion:change?1:0,
    text:JSON.stringify({projectId,taskId:ctx.task.id,sha:handoff.sha,preview:url,pr:handoff.pr.number})});
  return action('task.submit',{note:'Verified the ISO sample in an isolated build.',evidence:[url,handoff.sha,projectId]});
}

const app = createApp({dataDir,username:'owner',passwordHash:await hashPassword('acceptance-owner'),decide:ctx=>{
  try {
    const chosen = decide(ctx);
    process.send({step:[ctx.kind,ctx.task?.workStep,chosen.op]});
    return chosen;
  } catch (e) {process.send({failure:e.message}); throw e;}
}});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const store = createStore(dataDir), records = makeSqliteRecords({filename:join(dataDir,'company.sqlite')});
const mail = createCompanyMail({store,records,domain});
const receive = createEmailIngress({store,mail,domain,topicArn,readOwnerIdentity:async()=>({address:founder,token})});
process.on('message',async msg=>{
  try {
    if (msg.close) {
      await app.close(); records.close(); store.close(); process.disconnect(); return;
    }
    const {number,reference,text} = msg;
    const headers = ['From: '+founder,'To: ceo@'+domain,'Subject: Country code app','Message-ID: <brief-'+number+'@example.invalid>'];
    if (reference) headers.push('In-Reply-To: '+reference,'References: <brief-1@example.invalid> '+reference);
    const item = {notificationType:'Received',mail:{messageId:'receipt-'+number,source:founder},
      receipt:{recipients:['owner-'+token+'@'+domain],...Object.fromEntries(['dkim','dmarc','spf','spam','virus'].map(k=>[k+'Verdict',{status:'PASS'}]))},
      content:Buffer.from([...headers,'Content-Type: text/plain; charset=utf-8','',text].join('\r\n')).toString('base64')};
    const received=await receive({Records:[{EventSource:'aws:sns',Sns:{TopicArn:topicArn,Message:JSON.stringify(item)}}]});
    process.send({received});
  } catch(e) {process.send({failure:e.message});}
});
process.send({origin:'http://127.0.0.1:'+app.server.address().port});
