import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { Template } from 'aws-cdk-lib/assertions';
import { createEmailIngress } from '../src/email-ingress.mjs';

const domain='office.example.org',topicArn='arn:aws:sns:us-east-1:111111111111:inbound';
const employees=[
  {id:'ceo',handle:'mara',role:'CEO',desiredState:'active'},
  {id:'sam',handle:'sam',role:'Engineer',desiredState:'paused'},
  {id:'jo',handle:'jo',role:'Engineer',desiredState:'active'},
  {id:'former',handle:'former',role:'Former',desiredState:'fired'}];
const token='a'.repeat(51)+'q',capability='owner-'+token+'@'+domain;
const store={listEmployees:async()=>employees};
function fixture(recipients,extraHeaders=[],body='Review draft',from='founder@example.net') {
  return {notificationType:'Received',receipt:{recipients,spamVerdict:{status:'PASS'},virusVerdict:{status:'PASS'},
    dkimVerdict:{status:'PASS'},dmarcVerdict:{status:'PASS'},spfVerdict:{status:'PASS'}},mail:{messageId:'receipt-123',source:from},
  content:Buffer.from(['From: '+from,'To: mara@'+domain,'Subject: =?UTF-8?B?UmV2aWV3IOKckw==?=','Message-ID: <this@example.net>',
    ...extraHeaders,'Content-Type: text/plain; charset=utf-8','',body].join('\r\n')).toString('base64')};
}
const event=m=>({Records:[{EventSource:'aws:sns',Sns:{TopicArn:topicArn,Message:JSON.stringify(m)}}]});
function setup(mail) { return createEmailIngress({store,domain,topicArn,mail,readOwnerIdentity:async()=>({address:'founder@example.net',token})}); }

test('verified envelope routes aliases once, preserves RFC threading, and keeps ordinary sender authority external',async()=>{
  const seen=[],ingress=setup({receive:async m=>seen.push(m)});
  const m=fixture(['ceo@'+domain,'mara@'+domain,'jo@'+domain,'engineer@'+domain,'former@'+domain,'sam@elsewhere.test'],
    ['References: <one@example.net>','In-Reply-To: <two@example.net>']);
  assert.deepEqual(await ingress(event(m)),{delivered:2,ignored:0});
  assert.deepEqual(seen.map(m=>m.employeeId),['ceo','jo']);
  assert.deepEqual(seen[0],{employeeId:'ceo',to:'ceo@'+domain,from:'founder@example.net',subject:'Review ✓',text:'Review draft',
    providerId:'receipt-123',rfcMessageId:'<this@example.net>',references:['<one@example.net>','<two@example.net>'],trustedOwner:false,canReply:true,allowThreading:true,notify:true});
});
test('only the private capability, pinned single From and SES DKIM/DMARC together confer founder authority',async()=>{
  const received=[],ingress=setup({receive:async m=>received.push(m)});
  const m=fixture(['ceo@'+domain,capability],[], 'I sent this to '+capability);
  await ingress(event(m));
  assert.equal(received[0].trustedOwner,true);
  assert.equal(received[0].to,'mara@'+domain);
  assert.ok(!JSON.stringify(received[0]).includes(token));
  for(const candidate of [
    fixture(['mara@'+domain]),
    fixture([capability],[],'Spoof','other@example.net'),
    fixture([capability],['From: other@example.net']),
    fixture([capability],[],'two senders','founder@example.net, other@example.net'),
    fixture([capability],['Auto-Submitted: auto-replied']),
    {...m,receipt:{...m.receipt,dkimVerdict:{status:'FAIL'}}},
    {...m,receipt:{...m.receipt,dmarcVerdict:{status:'FAIL'}}}
  ]) {
    received.length=0; await ingress(event(candidate)); assert.ok(received.every(row=>!row.trustedOwner));
  }
});
test('ingress rejects untrusted events, malformed MIME encoding, spam and viruses; automatic replies never wake an employee',async()=>{
  const rows=[],ingress=setup({receive:async m=>rows.push(m)});
  const m=fixture(['ceo@'+domain]),forged=event(m); forged.Records[0].Sns.TopicArn+='-forged';
  await assert.rejects(ingress(forged),/source/);
  const setupEvent={Records:[{EventSource:'aws:sns',Sns:{TopicArn:topicArn,Subject:'Amazon SES Setup Notification'}}]};
  assert.deepEqual(await ingress(setupEvent),{delivered:0,ignored:1});
  for(const bad of ['spamVerdict','virusVerdict']) {
    const invalid=structuredClone(m);invalid.receipt[bad].status='FAIL';assert.equal((await ingress(event(invalid))).delivered,0);
  }
  await assert.rejects(ingress(event({...m,content:'x+'.repeat(120000)})),/size/);
  await assert.rejects(ingress(event({...m,content:'+'})),/encoding/);
  await ingress(event(fixture(['mara@'+domain],['Auto-Submitted: auto-replied'])));
  assert.equal(rows[0].notify,false); assert.equal(rows[0].canReply,false);
  const unverified=structuredClone(m);for(const k of ['spfVerdict','dkimVerdict','dmarcVerdict']) delete unverified.receipt[k];
  await ingress(event(unverified));assert.equal(rows[1].notify,false);
});
test('each employee delivery retains its SES receipt through partial retries',async()=>{
  const collected=new Set();let ready=false;
  const ingress=setup({receive:async m=>{if(m.employeeId==='sam'&&!ready) throw Error('offline');collected.add(m.employeeId+'/'+m.providerId);}});
  const incoming=event(fixture(['ceo@'+domain,'sam@'+domain]));
  await assert.rejects(ingress(incoming),/offline/);ready=true;await ingress(incoming);
  assert.deepEqual([...collected],['ceo/receipt-123','sam/receipt-123']);
});
test('optional receiving and sending roles isolate SES, event origins and foundation writes',()=>{
  const stack=new Stack(new App(),'Mail');new CfnInclude(stack,'Records',{templateFile:fileURLToPath(new URL('../infra/inbound-email.yaml',import.meta.url))});
  const {Resources:r}=Template.fromStack(stack).toJSON();
  assert.deepEqual(r.Receipt.Properties.Rule.Recipients,[{Ref:'MailDomain'}]);
  assert.equal(r.Receipt.Properties.Rule.Actions[0].SNSAction.Encoding,'Base64');assert.equal(r.Receipt.Properties.Rule.ScanEnabled,true);
  assert.deepEqual(r.InvokePermission.Properties.SourceArn,{Ref:'Topic'});assert.deepEqual(r.EventPermission.Properties.SourceArn,{Ref:'EventsTopic'});
  assert.equal([r.ClockPermission.Properties.SourceArn['Fn::GetAtt']].flat().join('.'),'OutboxClock.Arn');
  const inbound=JSON.stringify(r.MailRole.Properties.Policies);
  assert.match(inbound,/V2#mail-/);assert.doesNotMatch(inbound,/ses:Send|ecs:RunTask|FACTORY#CONTROL|mail-outbox/);
  const sender=JSON.stringify(r.SenderRole.Properties.Policies);
  assert.match(sender,/ses:SendEmail/);assert.match(sender,/ses:FromAddress/);assert.doesNotMatch(sender,/SendRawEmail|FACTORY#CONTROL/);
  for(const role of [r.MailRole,r.SenderRole]) {
    const statements=role.Properties.Policies[0].PolicyDocument.Statement;
    const writes=statements.find(s=>s.Action.includes('dynamodb:UpdateItem'));
    const keys=writes.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    assert.ok(keys.includes('V2#event-id') && keys.includes('V2#company-events'));
    assert.ok(!keys.includes('V2#*'));
    const reads=statements.find(s=>s.Action.includes('dynamodb:GetItem'));
    assert.ok(!reads.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'].includes('V2#company-events'));
  }
  assert.equal(r.Sender.Properties.ImageConfig.Command[0],'src/company-mail-ses.handler');
  assert.equal([r.Subscription.Properties.RedrivePolicy.deadLetterTargetArn['Fn::GetAtt']].flat().join('.'),'Failures.Arn');
  assert.doesNotMatch(JSON.stringify(r),/AWS::Route53::RecordSet|AWS::SES::ReceiptRuleSet/);
});
