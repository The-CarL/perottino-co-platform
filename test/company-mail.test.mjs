import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { createCompanyMail } from '../src/company-mail.mjs';
import { createLocalMailTransport,dispatchCompanyMail,recordMailReceipt } from '../src/company-mail-outbox.mjs';
import { createSesMailTransport,createMailSender } from '../src/company-mail-ses.mjs';
import { createWork } from '../src/company-work.mjs';
import { deliverNextGoalNotice } from '../src/company-notifications.mjs';

const domain='office.example.org';
function fixture(t,options={}) {
  const records=makeSqliteRecords({filename:':memory:'});t.after(()=>records.close());
  const persons=[{id:'ceo',handle:'mara',name:'Mara',role:'CEO',desiredState:'active'},
    {id:'eng',handle:'kai',name:'Kai',role:'Engineer',managerId:'ceo',desiredState:'active'}];
  const store={employee:async id=>persons.find(p=>p.id===id),listEmployees:async()=>persons};
  let time=Date.now();const now=()=>time;
  const transport=options.capture?createLocalMailTransport({records}):undefined;
  const mail=createCompanyMail({records,store,domain,transport,externalEnabled:true,now});
  const inbound=(more={})=>mail.receive({employeeId:'ceo',to:'ceo@'+domain,from:'customer@example.net',subject:'Preview',text:'First question.',
    rfcMessageId:'<a@example.net>',providerId:'receipt-1',...more});
  return {records,store,persons,now,mail,inbound,advance:ms=>{time+=ms;},dispatch:transport=>dispatchCompanyMail({records,store,domain,now,transport})};
}
test('same external thread survives ingress replay and provider-ID routing; bystanders cannot read or splice it',async t=>{
  const {mail,records,inbound}=fixture(t,{capture:true});
  const a=await inbound();assert.deepEqual(await inbound(),a);
  const d=(await mail.execute('ceo','mail.claim',{})).delivery;
  assert.equal(d.external,true);assert.equal(d.trustedOwner,false);
  const sent=await mail.execute('ceo','mail.finish',{deliveryId:d.id,token:d.token,replyText:'Here is your preview.'});
  assert.equal((await mail.execute('ceo','mail.finish',{deliveryId:d.id,token:d.token,replyText:'retry'})).ok,true);
  const outbound=await records.get('mail-messages',sent.messageId);
  assert.equal(outbound.from,'ceo@'+domain);assert.equal(outbound.to,'customer@example.net');assert.equal(outbound.status,'sent');
  assert.equal(outbound.inReplyTo,'<a@example.net>');
  const headers=await records.get('mail-capture',outbound.providerId);assert.deepEqual(headers.references,['<a@example.net>']);
  const reference='<'+outbound.providerId+'@email.amazonses.com>';
  const follow=await inbound({providerId:'receipt-2',rfcMessageId:'<b@example.net>',references:[reference],text:'New change.'});
  assert.equal(follow.threadId,a.threadId);
  assert.equal((await mail.execute('owner','mail.get',{threadId:a.threadId})).messages.length,3);
  const history=await mail.execute('ceo','mail.get',{threadId:a.threadId,throughMessageId:sent.messageId,limit:1});
  assert.deepEqual(history.messages.map(m=>m.id),[sent.messageId]);
  assert.equal(history.next,undefined);
  const stranger=await inbound({from:'else@example.net',providerId:'else',references:[reference]});
  assert.notEqual(stranger.threadId,a.threadId);
  await assert.rejects(mail.execute('eng','mail.get',{threadId:a.threadId}),{status:404});
  await assert.rejects(mail.execute('ceo','mail.reply',{threadId:a.threadId,messageId:a.messageId,to:'else@example.net',text:'x',requestId:'forge'}),{status:400});
});
test('handles and role aliases work for internal mail, public sender cannot be forged and staff auto-replies stop at the originating inbox',async t=>{
  const {mail}=fixture(t);
  const msg={to:'engineer@'+domain,subject:'Work',text:'Please review.',requestId:'start'};
  const a=await mail.execute('ceo','mail.send',msg);
  assert.deepEqual(await mail.execute('ceo','mail.send',msg),a);
  await assert.rejects(mail.execute('ceo','mail.send',{...msg,text:'different'}),{status:409});
  await assert.rejects(mail.execute('eng','mail.send',{...msg,employeeId:'ceo'}),{status:403});
  const d=(await mail.execute('eng','mail.claim',{})).delivery;
  assert.equal(d.senderId,'ceo'); assert.equal(d.external,false);
  await mail.execute('eng','mail.finish',{deliveryId:d.id,token:d.token,replyText:'Reviewed.'});
  assert.equal((await mail.execute('ceo','mail.claim',{})).delivery,null);
  const page=await mail.execute('owner','mail.get',{threadId:a.threadId,limit:1});
  assert.equal(page.messages[0].text,'Please review.');
  const next=await mail.execute('owner','mail.get',{threadId:a.threadId,after:page.next});
  assert.equal(next.messages[0].text,'Reviewed.');
  assert.equal((await mail.execute('eng','mail.list',{})).threads.length,1);
});
test('uncertain send is not transmitted again; tagged provider events reconcile it without downgrading delivery',async t=>{
  const {mail,dispatch,records,advance,now}=fixture(t);
  const m=await mail.execute('ceo','mail.send',{to:'customer@example.net',subject:'Hello',text:'Hi',requestId:'id'});
  let sends=0;
  const transport={async send(){sends++;throw Error('timeout after request');}};
  await dispatch(transport);advance(900000);await dispatch(transport);
  assert.equal(sends,1);assert.equal((await records.get('mail-messages',m.messageId)).status,'uncertain');
  const handler=createMailSender({records,domain,topicArn:'trusted',configurationSet:'configured'});
  const event=kind=>({Records:[{EventSource:'aws:sns',Sns:{TopicArn:'trusted',Message:JSON.stringify({eventType:kind,mail:{
    messageId:'provider-id',source:'mara@'+domain,destination:['customer@example.net'],tags:{'ses:configuration-set':['configured'],'company-mail-id':[m.messageId]}}})}}]});
  await handler(event('Delivery'));await handler(event('Send'));await handler(event('Delivery'));
  assert.equal((await records.get('mail-messages',m.messageId)).status,'delivered');
  assert.equal(await recordMailReceipt({records,id:m.messageId,provider:'forged',status:'bounced',from:'mara@'+domain,to:'wrong@example.org',at:now()}),false);
});
test('explicit throttling permits safe bounded retry; fired employees cannot dispatch queued mail',async t=>{
  const {mail,dispatch,store,persons,advance,records}=fixture(t);
  const msg=await mail.execute('ceo','mail.send',{to:'customer@example.net',subject:'Hello',text:'Hi',requestId:'one'});
  let calls=0;const transport={async send(){if(++calls===1)throw Object.assign(Error(),{name:'TooManyRequestsException'});return{providerId:'ok'};}};
  await dispatch(transport);await dispatch(transport);assert.equal(calls,1);advance(61000);await dispatch(transport);
  assert.equal(calls,2);assert.equal((await records.get('mail-messages',msg.messageId)).status,'sent');
  const next=await mail.execute('ceo','mail.send',{to:'customer@example.net',subject:'bye',text:'Bye',requestId:'two'});
  persons[0].desiredState='fired';await dispatch(transport);
  assert.equal(calls,2);assert.equal((await records.get('mail-messages',next.messageId)).status,'failed');
});
test('trusted owner source allows bounded goal handoff to original email; unsigned source cannot attach and private goals do not send',async t=>{
  const {mail,records,store,inbound}=fixture(t,{capture:true});
  const source=await inbound(),trust=await inbound({providerId:'auth',rfcMessageId:'<owner@example.net>',trustedOwner:true});
  const work=createWork({records,employee:store.employee,canUseMailSource:mail.canUseSource});
  const content={accountableId:'ceo',outcome:'ship',successCriteria:'reviewed'};
  await assert.rejects(work.execute('ceo','goal.create',{...content,requestId:'deny',sourceMail:{threadId:source.threadId,messageId:source.messageId}}),{status:404});
  const sourceMail={threadId:trust.threadId,messageId:trust.messageId};
  const {goal}=await work.execute('ceo','goal.create',{...content,requestId:'allow',sourceMail});
  assert.equal(goal.sourceMail,undefined);
  const {task}=await work.execute('ceo','task.create',{goalId:goal.id,assigneeId:'eng',title:'Deploy preview',acceptance:'URL responds',requestId:'build'});
  const {claimToken}=await work.execute('eng','task.claim',{taskId:task.id,requestId:'claim'});
  await work.execute('eng','task.submit',{taskId:task.id,claimToken,evidence:['Internal raw notes'],requestId:'test'});
  const close={goalId:goal.id,requestId:'close',requesterReply:'The reviewed preview is ready at https://preview.example.org.'};
  await assert.rejects(work.execute('ceo','goal.close',close),{status:409});
  await work.execute('ceo','task.review',{taskId:task.id,decision:'accept',note:'Verified',requestId:'review'});
  await work.execute('ceo','goal.close',close);
  await work.execute('ceo','goal.close',close);
  await deliverNextGoalNotice({actor:'ceo',records,mail});
  const thread=await mail.execute('owner','mail.get',{threadId:trust.threadId});
  assert.doesNotMatch(thread.messages.at(-1).text,/Internal raw notes/);
  assert.match(thread.messages.at(-1).text,/https:\/\/preview.example.org/);
  assert.equal(thread.messages.at(-1).to,'customer@example.net');assert.equal(thread.messages.at(-1).status,'sent');
  assert.equal(await deliverNextGoalNotice({actor:'ceo',records,mail}),false);
});
test('SES adapter binds sender/recipient/tags, sets RFC reply headers, and adds owner routing only on verified owner replies',async()=>{
  const sent=[];class C{constructor(input){this.input=input;}}
  const transport=createSesMailTransport({client:{send:async c=>{sent.push(c.input);return {MessageId:'id'};}},SendEmailCommand:C,
    domain,configurationSet:'configured',readOwnerIdentity:async()=>({address:'owner@example.net',token:'a'.repeat(52)})});
  const m={id:'a'.repeat(64),from:'ceo@'+domain,to:'owner@example.net',subject:'Re: Work',text:'Done',inReplyTo:'<in@example.net>',references:['<first@example.net>','<in@example.net>']};
  await transport.send(m);await transport.send({...m,ownerReplyRoute:true});
  assert.equal(sent[0].ReplyToAddresses,undefined);assert.ok(sent[1].ReplyToAddresses[0].startsWith('owner-'));
  assert.deepEqual(sent[0].Destination.ToAddresses,['owner@example.net']);assert.equal(sent[0].EmailTags[0].Value,m.id);
  assert.ok(sent[0].Content.Simple.Headers.some(h=>h.Name==='References'&&h.Value==='<first@example.net> <in@example.net>'));
});

test('owner MIME brief and follow-up run through the same persistent SQLite records and local transport after a restart',async t=>{
  const [{mkdtemp,rm},{tmpdir},{join},{createEmailIngress}]=await Promise.all([
    import('node:fs/promises'),import('node:os'),import('node:path'),import('../src/email-ingress.mjs')]);
  const dir=await mkdtemp(join(tmpdir(),'company-mail-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ceo={id:'ceo',handle:'mara',role:'CEO',desiredState:'active'};
  const store={employee:async id=>id==='ceo'?ceo:null,listEmployees:async()=>[ceo]};
  const token='b'.repeat(51)+'a',owner='founder@example.net';
  const make=()=>{
    const records=makeSqliteRecords({filename:join(dir,'company.sqlite')});
    const mail=createCompanyMail({records,domain,store,transport:createLocalMailTransport({records})});
    const receive=createEmailIngress({mail,domain,store,topicArn:'fixture',readOwnerIdentity:async()=>({address:owner,token})});
    return {records,mail,receive};
  };
  const mime=(provider,rfc,subject,text,reference)=>{
    const raw=['From: '+owner,'To: owner-'+token+'@'+domain,'Message-ID: '+rfc,'Subject: '+subject,
      ...(reference?['In-Reply-To: '+reference,'References: '+reference]:[]),'Content-Type: text/plain','',''+text].join('\r\n');
    const item={notificationType:'Received',mail:{messageId:provider,source:owner},receipt:{recipients:['owner-'+token+'@'+domain],
      ...Object.fromEntries(['virusVerdict','spamVerdict','dkimVerdict','dmarcVerdict'].map(k=>[k,{status:'PASS'}]))},content:Buffer.from(raw).toString('base64')};
    return {Records:[{EventSource:'aws:sns',Sns:{TopicArn:'fixture',Message:JSON.stringify(item)}}]};
  };
  let instance=make();
  try {
    const initial=mime('ses-one','<one@example.net>','Public data app','Please prepare a preview.');
    await instance.receive(initial);await instance.receive(initial);
    const {delivery}=await instance.mail.execute('ceo','mail.claim',{});
    assert.equal(delivery.trustedOwner,true);
    assert.ok(!JSON.stringify(delivery).includes(token));
    const result=await instance.mail.execute('ceo','mail.finish',{deliveryId:delivery.id,token:delivery.token,replyText:'The preview is ready.'});
    const sent=await instance.records.get('mail-messages',result.messageId);
    assert.equal(sent.status,'sent');
    instance.records.close();instance=make();
    const wire='<'+sent.providerId+'@email.amazonses.com>';
    await instance.receive(mime('ses-two','<follow@example.net>','Re: Public data app','Please update it.',wire));
    const next=(await instance.mail.execute('ceo','mail.claim',{})).delivery;
    assert.equal(next.threadId,delivery.threadId);assert.equal(next.trustedOwner,true);
    const view=await instance.mail.execute('owner','mail.get',{threadId:next.threadId});
    assert.deepEqual(view.messages.map(m=>m.text),['Please prepare a preview.','The preview is ready.','Please update it.']);
  } finally {instance.records.close();}
});
