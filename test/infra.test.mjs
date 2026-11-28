import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synthFoundation } from '../infra/foundation.mjs';

function fixture() {
  return JSON.parse(readFileSync(new URL('../infra/example-provenance.json', import.meta.url), 'utf8'));
}

function render(t, provenance = fixture()) {
  const dir = mkdtempSync(join(tmpdir(), 'company-foundation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return synthFoundation(provenance, dir);
}

function byType(template, type) {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
}

test('the asset-free assembly and its CloudFormation template are repeatable', t => {
  const stack = render(t);
  assert.deepEqual(stack.template, render(t).template);
  const { properties } = stack.manifest;
  assert.equal(properties.stackName, 'factory-11111111-1111-4111-8111-111111111111-example-r-foundation');
  assert.equal(properties.terminationProtection, true);
  assert.equal(properties.assumeRoleArn, undefined);
  assert.equal(properties.cloudFormationExecutionRoleArn, undefined);
  assert.deepEqual(Object.keys(stack.template.Outputs).sort(), [
    'CorporateBucketName', 'DeadLetterQueueUrl', 'StateTableName', 'WakeQueueUrl',
  ]);
  assert.deepEqual(Object.values(stack.template.Resources).map(resource => resource.Type).sort(), [
    'AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::SQS::Queue',
    'AWS::SQS::Queue', 'AWS::SQS::QueuePolicy', 'AWS::SQS::QueuePolicy',
  ]);
  for (const resource of Object.values(stack.template.Resources)) {
    assert.equal(resource.DeletionPolicy, 'Retain');
    assert.equal(resource.UpdateReplacePolicy, 'Retain');
  }
});

test('durable state, versioned corporate files, and encrypted wake redrive are configured', t => {
  const template = render(t).template;
  const [[, { Properties: table }]] = byType(template, 'AWS::DynamoDB::Table');
  assert.equal(table.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(table.DeletionProtectionEnabled, true);
  assert.equal(table.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.deepEqual(table.KeySchema, [
    { AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' },
  ]);
  const [[, { Properties: bucket }]] = byType(template, 'AWS::S3::Bucket');
  assert.equal(bucket.VersioningConfiguration.Status, 'Enabled');
  assert.equal(bucket.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.equal(bucket.OwnershipControls.Rules[0].ObjectOwnership, 'BucketOwnerEnforced');
  assert.deepEqual(bucket.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
  });

  const queues = byType(template, 'AWS::SQS::Queue');
  const [deadId, dead] = queues.find(([, queue]) => !queue.Properties.RedrivePolicy);
  const [, wake] = queues.find(([, queue]) => queue.Properties.RedrivePolicy);
  assert.ok(queues.every(([, queue]) => queue.Properties.SqsManagedSseEnabled === true));
  assert.deepEqual(wake.Properties.RedrivePolicy, {
    deadLetterTargetArn: { 'Fn::GetAtt': [deadId, 'Arn'] }, maxReceiveCount: 5,
  });
  assert.ok(dead.Properties.MessageRetentionPeriod > wake.Properties.MessageRetentionPeriod);
  assert.equal(wake.Properties.VisibilityTimeout, 300);

  const policies = [...byType(template, 'AWS::S3::BucketPolicy'), ...byType(template, 'AWS::SQS::QueuePolicy')];
  for (const [, resource] of policies) {
    const [statement] = resource.Properties.PolicyDocument.Statement;
    assert.equal(statement.Effect, 'Deny');
    assert.deepEqual(statement.Principal, { AWS: '*' });
    assert.deepEqual(statement.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  }
});

test('all taggable resources carry factory provenance; a queue change keeps other records stable', t => {
  const original = fixture();
  const edited = fixture();
  edited.overrides.Wake = { 'factory:last-run-id': 'queue-update' };
  const before = render(t, original).template;
  const after = render(t, edited);
  const scope = original.tags['factory:project-id'] + '-example';
  const stackTags = after.manifest.properties.tags;
  assert.equal(stackTags['factory:s'], scope);
  for (const [id, resource] of Object.entries(after.template.Resources)) {
    if (!resource.Properties.Tags) {
      assert.ok(resource.Type.endsWith('Policy'));
      continue;
    }
    const tags = Object.fromEntries(resource.Properties.Tags.map(({ Key, Value }) => [Key, Value]));
    if (resource.Properties.RedrivePolicy) {
      assert.deepEqual(tags, { ...original.tags, 'factory:s': scope, 'factory:last-run-id': 'queue-update' });
    } else {
      assert.deepEqual(tags, { ...original.tags, 'factory:s': scope });
      assert.deepEqual(resource, before.Resources[id]);
    }
  }
});

test('invalid scope, partial provenance and relabeling through a resource override fail before synthesis', t => {
  for (const change of [
    input => { input.tags['factory:environment'] = 'dev-r-prod'; },
    input => { input.tags['factory:project-id'] = '00000000-0000-0000-0000-000000000000'; },
    input => { delete input.tags['factory:owner']; },
    input => { input.overrides.Files = { 'factory:project-id': 'replace' }; },
    input => { input.overrides.Unrecognized = {}; },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => render(t, input));
  }
});
