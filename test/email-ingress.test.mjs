import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { App, Stack } from 'aws-cdk-lib';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { Template } from 'aws-cdk-lib/assertions';
import { createEmailIngress } from '../src/email-ingress.mjs';

const domain = 'co.example.org';
const topicArn = 'arn:aws:sns:us-east-1:111111111111:company-mail';
const employees = [
  { id: 'ceo', handle: 'mara', role: 'CEO', desiredState: 'active' },
  { id: 'second', handle: 'sam', role: 'Software Engineer', desiredState: 'paused' },
  { id: 'third', handle: 'jo', role: 'Software Engineer', desiredState: 'active' },
  { id: 'former', handle: 'former', role: 'QA', desiredState: 'fired' }
];
function receipt(to) {
  const mail = { notificationType: 'Received', receipt: { recipients: to, spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' } },
    mail: { messageId: 'receipt-123', source: 'somebody@example.net' }, content: Buffer.from([
      'From: owner@example.org', 'To: sam@' + domain, 'Subject: =?UTF-8?B?UmV2aWV3IOKckw==?=',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Review=20draft'
    ].join('\r\n')).toString('base64') };
  return mail;
}
const event = mail => ({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: topicArn, Message: JSON.stringify(mail) } }] });

test('scanned SES delivery routes by envelope and resolves both aliases into a single employee receipt', async () => {
  const received = [];
  const ingest = createEmailIngress({ domain, topicArn, store: { listEmployees: async () => employees,
    enqueueEmail: async (id, mail) => { received.push([id, mail]); return {}; } } });
  const source = receipt(['CEO@CO.EXAMPLE.ORG', 'mara@' + domain, 'jo@' + domain, 'software-engineer@' + domain,
    'sam@unrelated.net', 'former@' + domain]);
  assert.deepEqual(await ingest(event(source)), { delivered: 2, ignored: 0 });
  assert.deepEqual(received.map(([id]) => id), ['ceo', 'third']);
  assert.deepEqual(received[0][1], { messageId: 'receipt-123', to: 'ceo@' + domain, from: 'somebody@example.net',
    subject: 'Review ✓', text: 'Review draft' });
});

test('mail delivery retries partial store failure using the stable provider ID per employee', async () => {
  const inbox = new Set();
  let online = false;
  const ingest = createEmailIngress({ domain, topicArn, store: { listEmployees: async () => employees,
    enqueueEmail: async (id, mail) => {
      if (id === 'second' && !online) throw new Error('store unavailable');
      inbox.add(id + '/' + mail.messageId);
    } } });
  const incoming = event(receipt(['ceo@' + domain, 'sam@' + domain]));
  await assert.rejects(ingest(incoming), /unavailable/);
  online = true;
  await ingest(incoming);
  assert.deepEqual([...inbox], ['ceo/receipt-123', 'second/receipt-123']);
});

test('ingress checks event origin, receipt verdicts and payload before storing mail', async () => {
  const attempts = [];
  const ingest = createEmailIngress({ domain, topicArn, store: { listEmployees: async () => employees,
    enqueueEmail: async (...args) => { attempts.push(args); } } });
  const setup = { EventSource:'aws:sns', Sns:{ TopicArn:topicArn, Subject:'Amazon SES Setup Notification', Message:'Setup complete' } };
  assert.deepEqual(await ingest({ Records:[setup] }), { delivered:0, ignored:1 });
  const source = receipt(['ceo@' + domain]);
  const forged = event(source);
  forged.Records[0].Sns.TopicArn += '-wrong';
  await assert.rejects(ingest(forged), /source/);
  for (const verdict of ['spamVerdict', 'virusVerdict']) {
    const rejected = structuredClone(source);
    rejected.receipt[verdict].status = 'FAIL';
    assert.deepEqual(await ingest(event(rejected)), { delivered: 0, ignored: 1 });
  }
  await assert.rejects(ingest(event({ ...source, content: '+' })), /encoding/);
  await assert.rejects(ingest(event({ ...source, content: 'a'.repeat(205000) })), /size/);
  assert.deepEqual(await ingest(event(receipt(['no-such-address@' + domain]))), { delivered: 0, ignored: 1 });
  assert.equal(attempts.length, 0);
});

test('optional mail infrastructure scopes the receiving domain, SES rule, SNS trigger and DynamoDB writes', () => {
  const stack = new Stack(new App(), 'Mail');
  new CfnInclude(stack, 'Resources', { templateFile: fileURLToPath(new URL('../infra/inbound-email.yaml', import.meta.url)) });
  const { Resources: r } = Template.fromStack(stack).toJSON();
  assert.deepEqual(r.Receipt.Properties.Rule.Recipients, [{ Ref: 'MailDomain' }]);
  assert.equal(r.Receipt.Properties.Rule.Actions[0].SNSAction.Encoding, 'Base64');
  assert.equal(r.Receipt.Properties.Rule.ScanEnabled, true);
  assert.deepEqual(r.Receipt.Properties.RuleSetName, { Ref: 'ActiveReceiptRuleSet' });
  assert.deepEqual(r.InvokePermission.Properties.SourceArn, { Ref: 'Topic' });
  assert.equal(r.TopicPolicy.Properties.PolicyDocument.Statement[0].Principal.Service, 'ses.amazonaws.com');
  assert.deepEqual(r.TopicPolicy.Properties.PolicyDocument.Statement[0].Condition.StringEquals['aws:SourceAccount'], { Ref: 'AWS::AccountId' });
  assert.deepEqual(r.Subscription.Properties.RedrivePolicy.deadLetterTargetArn, { 'Fn::GetAtt': 'Failures.Arn' });
  assert.deepEqual(r.DeliveryFailure.Properties.DestinationConfig.OnFailure.Destination, { 'Fn::GetAtt': 'Failures.Arn' });
  const policy = r.MailRole.Properties.Policies[0].PolicyDocument.Statement;
  const writes = policy.find(statement => statement.Action.includes('dynamodb:PutItem'));
  assert.deepEqual(writes.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'], ['AGENT#*']);
  assert.doesNotMatch(JSON.stringify(policy), /ecs:RunTask|lambda:InvokeFunction|ses:Send|secretsmanager:|FACTORY/);
  assert.doesNotMatch(JSON.stringify(r), /AWS::Route53::RecordSet|AWS::SES::ReceiptRuleSet/);
});
