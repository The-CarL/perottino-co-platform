import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synthHosted } from '../infra/hosted.mjs';

const fixture = name => JSON.parse(readFileSync(new URL('../infra/' + name, import.meta.url)));
const sample = () => fixture('example-hosted.json');
function render(t, config = sample(), provenance = fixture('example-provenance.json')) {
  const dir = mkdtempSync(join(tmpdir(), 'company-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return synthHosted(config, provenance, dir);
}
const props = (r, key) => r[key].Properties;
const grants = (r, role) => r[role].Properties.Policies[0].PolicyDocument.Statement;
const actions = (r, role) => grants(r, role).flatMap(statement => statement.Action);
const att = (id, name) => ({ 'Fn::GetAtt': [id, name] });

test('cold-start infrastructure has zero resident compute and a durable replay source', t => {
  const template = render(t).template;
  const r = template.Resources;
  const types = Object.values(r).map(x => x.Type);
  for (const kind of ['EC2::Instance', 'EC2::Volume', 'EC2::EIP', 'EC2::NatGateway', 'EFS::FileSystem', 'ECS::Service',
    'ElasticLoadBalancingV2::LoadBalancer', 'Scheduler::Schedule']) assert.ok(!types.includes('AWS::' + kind));
  assert.ok(!JSON.stringify(template).includes('ProvisionedConcurrency'));
  const stops = props(r, 'StoppedWork');
  assert.equal(stops.ScheduleExpression, undefined);
  assert.deepEqual(stops.EventPattern.detail.status, ['FAILED', 'ABORTED', 'TIMED_OUT']);
  assert.deepEqual(stops.EventPattern.detail.stateMachineArn, [{ Ref: 'Workflow' }]);
  assert.deepEqual(stops.Targets[0].Arn, att('RecoveryQueue', 'Arn'));
  assert.doesNotMatch(stops.Targets[0].InputTransformer.InputTemplate, /prompt|input|credential/i);
  assert.equal(props(r, 'RecoveryQueue').SqsManagedSseEnabled, true);
  assert.equal(types.filter(x => x === 'AWS::Lambda::Function').length, 4);
  assert.equal(types.filter(x => x === 'AWS::ECS::TaskDefinition').length, 1);
  const table = props(r, 'State');
  assert.equal(table.BillingMode, 'PAY_PER_REQUEST');
  assert.ok(table.DeletionProtectionEnabled && table.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled);
  assert.equal(table.StreamSpecification.StreamViewType, 'NEW_IMAGE');
  assert.deepEqual(table.KeySchema.map(k => k.AttributeName), ['pk', 'sk']);
  for (const id of ['State', 'Failures', 'FailurePolicy', 'Logs']) {
    assert.equal(r[id].DeletionPolicy, 'Retain');
    assert.equal(r[id].UpdateReplacePolicy, 'Retain');
  }
  const mapping = props(r, 'StreamMapping');
  assert.equal(mapping.StartingPosition, 'TRIM_HORIZON');
  assert.deepEqual(mapping.FunctionResponseTypes, ['ReportBatchItemFailures']);
  assert.deepEqual(JSON.parse(mapping.FilterCriteria.Filters[0].Pattern), {
    dynamodb: { NewImage: { kind: { S: ['job'] }, state: { S: ['queued'] } } },
  });
  assert.deepEqual(mapping.DestinationConfig.OnFailure.Destination, att('Failures', 'Arn'));
  assert.ok(props(r, 'Failures').PublicAccessBlockConfiguration.BlockPublicPolicy);
  assert.equal(props(r, 'Failures').VersioningConfiguration.Status, 'Enabled');
});

test('two commercial accounts synthesize independently, including optional HTTPS custom domain and private inputs', t => {
  const from = render(t);
  const config = JSON.parse(JSON.stringify(sample()).replaceAll('111111111111', '222222222222').replaceAll('us-east-1', 'us-east-2'));
  const host = 'chat.example.net';
  config.customDomain = { hostname: host, certificateArn: 'arn:aws:acm:us-east-2:222222222222:certificate/bbbbbbbb-aaaa-cccc-dddd-eeeeeeeeeeee',
    hostedZoneId: 'ZEXAMPLE123456' };
  const to = render(t, config);
  assert.equal(to.environment.name, 'aws://222222222222/us-east-2');
  assert.deepEqual(to.template, render(t, config).template);
  assert.doesNotMatch(JSON.stringify(to.template), /111111111111\.dkr|:111111111111:|us-east-1|carloperottino\.com/);
  const r = to.template.Resources;
  assert.deepEqual(props(r, 'Domain').DomainNameConfigurations, [{ CertificateArn: config.customDomain.certificateArn,
    EndpointType: 'REGIONAL', SecurityPolicy: 'TLS_1_2' }]);
  assert.deepEqual(props(r, 'Dns').AliasTarget.DNSName, att('Domain', 'RegionalDomainName'));
  assert.equal(to.template.Outputs.Url.Value, 'https://' + host + '/chat');
  assert.ok(!from.template.Resources.Domain);
  assert.equal(props(from.template.Resources, 'HttpApi').DisableExecuteApiEndpoint, false);
  assert.deepEqual(props(from.template.Resources, 'WebFn').Environment.Variables.PUBLIC_ORIGIN, att('HttpApi', 'ApiEndpoint'));
  assert.equal(props(r, 'DefaultRoute').RouteKey, '$default');
  assert.equal(props(r, 'ApiIntegration').PayloadFormatVersion, '2.0');
  assert.ok(props(r, 'HttpApi').DisableExecuteApiEndpoint);
  delete config.customDomain.hostedZoneId;
  assert.equal(render(t, config).template.Resources.Dns, undefined);
});

test('invalid AWS bindings, PAT reuse, mutable image tags and a namespace too long for Lambda are rejected', t => {
  for (const change of [
    c => { c.workerImage = c.workerImage.replace('@sha256:', ':'); },
    c => { c.lambdaImage = c.lambdaImage.replace('111111111111', '222222222222'); },
    c => { c.lambdaImage = c.lambdaImage.replace('example-company', 'other-company'); },
    c => { c.publicSubnetIds = []; },
    c => { c.workerSize = 'huge'; },
    c => { c.ownerSecretArn = c.ownerSecretArn.replace('example/owner', '/perottino-co/github/pat'); },
    c => { c.bedrockResourceArns.push('*'); },
    c => { c.customDomain = { hostname: 'test.example.com', certificateArn: '*' }; },
    c => { c.permissionsBoundaryArn += '*'; },
  ]) { const conf = sample(); change(conf); assert.throws(() => render(t, conf), /Invalid hosted configuration/); }
  const prov = fixture('example-provenance.json'); prov.tags['factory:environment'] = 'very-long-environment-name';
  assert.throws(() => render(t, sample(), prov), /function-name limit/);
});

test('only admitted jobs launch bounded Fargate workers, and completed launches re-read durable state', t => {
  const r = render(t).template.Resources;
  assert.equal(props(r, 'Workflow').StateMachineType, 'STANDARD');
  const states = props(r, 'Workflow').Definition.States;
  assert.equal(states.Initialize.Next, 'CheckAdmission');
  assert.deepEqual(states.CheckAdmission.Resource, att('AdmissionFn', 'Arn'));
  assert.ok(states.Admission.Choices.some(c => c.Next === 'CountLaunch' && c.And.some(v => v.StringEquals === 'ready')
    && c.And.some(v => v.NumericLessThan === 3)));
  assert.ok(states.Admission.Choices.some(c => c.StringEquals === 'failed' && c.Next === 'TurnFailed'));
  assert.equal(states.CountLaunch.Next, 'RunEmployee');
  assert.equal(states.WaitForAgent.Next, 'CheckAdmission');
  assert.equal(states.RunEmployee.Resource, 'arn:aws:states:::ecs:runTask.sync');
  assert.equal(states.RunEmployee.TimeoutSeconds, 600);
  assert.deepEqual(states.RunEmployee.Parameters.TaskDefinition, { Ref: 'WorkerTask' });
  assert.equal(states.RunEmployee.Parameters.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'ENABLED');
  assert.equal(states.CheckExit.Choices[0].Next, 'CheckAdmission');
  assert.equal(states.RunEmployee.Catch[0].Next, 'RecoverLease');
  assert.equal(states.RecoverLease.Next, 'CheckAdmission');
  assert.deepEqual(states.RecordFailure.Resource, att('TerminalFn', 'Arn'));
  assert.equal(states.RecordFailure.Catch[0].Next, 'PrepareRecoveryRecord');
  assert.equal(states.TerminalResult.Default, 'PrepareRecoveryRecord');
  assert.deepEqual(states.ArchiveRecoveryRecord.Parameters.Bucket, { Ref: 'Failures' });
  const task = props(r, 'WorkerTask');
  assert.equal(task.Cpu, '256');
  assert.equal(task.Memory, '1024');
  for (const [workerSize, cpu, memory] of [['medium', '512', '1024'], ['large', '1024', '2048']]) {
    const alternate = render(t, { ...sample(), workerSize }).template.Resources.WorkerTask.Properties;
    assert.equal(alternate.Cpu, cpu);
    assert.equal(alternate.Memory, memory);
  }
  assert.deepEqual(task.RequiresCompatibilities, ['FARGATE']);
  assert.equal(task.NetworkMode, 'awsvpc');
  assert.equal(task.ContainerDefinitions.length, 1);
  const [worker] = task.ContainerDefinitions;
  assert.equal(worker.PortMappings, undefined);
  assert.equal(worker.Secrets, undefined);
  assert.deepEqual(worker.Command, ['node', 'src/cloud-worker.mjs']);
  assert.equal(props(r, 'WorkerSecurityGroup').SecurityGroupIngress, undefined);
  assert.deepEqual(props(r, 'WorkerSecurityGroup').SecurityGroupEgress.map(e => e.ToPort), [443]);
});

test('control roles, owner credentials, employee inference and stream recovery have distinct authority', t => {
  const config = sample(), r = render(t, config).template.Resources;
  const asserted = [['WebFn', 'a', 'src/cloud-api.handler'], ['DispatchFn', 'd', 'src/dispatch.handler'],
    ['AdmissionFn', 'i', 'src/dispatch.admit'], ['TerminalFn', 't', 'src/dispatch.terminal']];
  for (const [id, suffix, handler] of asserted) {
    assert.equal(props(r, id).FunctionName, 'factory-11111111-1111-4111-8111-111111111111-example-r-' + suffix);
    assert.deepEqual(props(r, id).ImageConfig.Command, [handler]);
    assert.deepEqual(props(r, id).Code, { ImageUri: config.lambdaImage });
  }
  const owner = grants(r, 'WebRole').find(s => s.Action === 'secretsmanager:GetSecretValue');
  assert.equal(owner.Resource, config.ownerSecretArn);
  assert.equal(owner.Condition.StringEquals['aws:ResourceTag/perottino:purpose'], 'owner-verifier');
  assert.ok(!actions(r, 'WebRole').includes('states:StartExecution'));
  for (const id of ['DispatchRole', 'WorkflowRole', 'ExecutionRole', 'WorkerRole', 'AdmissionRole', 'TerminalRole']) {
    assert.ok(!actions(r, id).includes('secretsmanager:GetSecretValue'));
    assert.equal(props(r, id).PermissionsBoundary, config.permissionsBoundaryArn);
  }
  assert.ok(!actions(r, 'AdmissionRole').includes('dynamodb:UpdateItem'));
  assert.ok(!actions(r, 'DispatchRole').includes('dynamodb:PutItem'));
  assert.ok(actions(r, 'WorkerRole').includes('bedrock-agentcore:ConnectBrowserAutomationStream'));
  assert.deepEqual(grants(r, 'WorkerRole').find(g => g.Action.includes('bedrock:InvokeModel')).Resource, config.bedrockResourceArns);
  const pass = grants(r, 'WorkflowRole').find(s => s.Action === 'iam:PassRole');
  assert.deepEqual(pass.Resource, [att('WorkerRole', 'Arn'), att('ExecutionRole', 'Arn')]);
  assert.equal(pass.Condition.StringEquals['iam:PassedToService'], 'ecs-tasks.amazonaws.com');
});
