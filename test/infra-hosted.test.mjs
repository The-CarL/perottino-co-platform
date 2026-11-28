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

test('one explicitly bootstrapped CEO uses standalone employee tasks with durable state', t => {
  const template = render(t).template;
  const r = template.Resources;
  const types = Object.values(r).map(x => x.Type);
  for (const kind of ['EC2::Instance', 'EC2::Volume', 'EC2::EIP', 'EC2::NatGateway', 'EFS::FileSystem',
    'ECS::Service', 'Lambda::EventSourceMapping', 'StepFunctions::StateMachine', 'ElasticLoadBalancingV2::LoadBalancer']) {
    assert.ok(!types.includes('AWS::' + kind));
  }
  assert.equal(types.filter(x => x === 'AWS::Lambda::Function').length, 7);
  assert.equal(types.filter(x => x === 'AWS::ECS::TaskDefinition').length, 1);
  const table = props(r, 'State');
  assert.equal(table.BillingMode, 'PAY_PER_REQUEST');
  assert.ok(table.DeletionProtectionEnabled && table.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled);
  assert.deepEqual(table.KeySchema.map(k => k.AttributeName), ['pk', 'sk']);
  assert.equal(table.StreamSpecification, undefined);
  for (const policy of ['DeletionPolicy', 'UpdateReplacePolicy']) {
    const retained = Object.keys(r).filter(id => r[id][policy] === 'Retain').sort();
    assert.deepEqual(retained, ['CorporateFiles','Logs', 'State', 'WorkerTask']);
  }
  assert.equal(r.WorkerTask.Properties.Family, 'factory-11111111-1111-4111-8111-111111111111-example-r-worker');
  const bootstrap = r.ResidentCompany;
  assert.equal(bootstrap.Type, 'Custom::ResidentCompany');
  assert.equal(bootstrap.DeletionPolicy, undefined);
  assert.deepEqual(bootstrap.Properties.ServiceToken, att('FactoryFn', 'Arn'));
  assert.deepEqual(bootstrap.Properties.TaskDefinitionArn, { Ref: 'WorkerTask' });
  assert.equal(bootstrap.Properties.WorkerImage, sample().workerImage);
  assert.equal(bootstrap.Properties.ReleaseImage, sample().lambdaImage);
  assert.equal(bootstrap.Properties.EmployeeLimit, '100');
  assert.equal(bootstrap.Properties.ResidentLimit, '100');
  const { employeeLimit, ...configWithDefault } = sample();
  assert.equal(employeeLimit, 100);
  const defaults = render(t, configWithDefault).template.Resources;
  assert.equal(defaults.ResidentCompany.Properties.EmployeeLimit, '100');
  assert.equal(defaults.ResidentCompany.Properties.ResidentLimit, '100');
  assert.equal(defaults.FactoryFn.Properties.Environment.Variables.PEROTTINO_EMPLOYEE_LIMIT, '100');
  assert.ok(bootstrap.Properties.ServiceTimeout > props(r, 'FactoryFn').Timeout);
  assert.deepEqual(bootstrap.DependsOn.sort(), ['ManagerFn', 'OwnerFn', 'RepairInvoke', 'StoppedInvoke']);
  const change = render(t, { ...sample(), employeeLimit: 6 }).template.Resources;
  assert.equal(change.ResidentCompany.Properties.EmployeeLimit, '6');
  assert.equal(change.ResidentCompany.Properties.ResidentLimit, '6');
  const assessment = render(t, { ...sample(), residentLimit: 3 }).template.Resources;
  assert.equal(assessment.ResidentCompany.Properties.EmployeeLimit, '100');
  assert.equal(assessment.ResidentCompany.Properties.ResidentLimit, '3');
  for (const handler of ['FactoryFn', 'ManagerFn', 'OwnerFn']) {
    assert.equal(change[handler].Properties.Environment.Variables.PEROTTINO_EMPLOYEE_LIMIT, '6');
    assert.equal(change[handler].Properties.Environment.Variables.PEROTTINO_RESIDENT_LIMIT, '6');
    assert.equal(assessment[handler].Properties.Environment.Variables.PEROTTINO_EMPLOYEE_LIMIT, '100');
    assert.equal(assessment[handler].Properties.Environment.Variables.PEROTTINO_RESIDENT_LIMIT, '3');
  }
  assert.deepEqual(assessment.WorkerTask, r.WorkerTask);
  assert.deepEqual(change.WorkerTask, r.WorkerTask);
  assert.deepEqual(change.State, r.State);
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
    c => { c.employeeLimit = 0; },
    c => { c.employeeLimit = 101; },
    c => { c.employeeLimit = '2'; },
    c => { c.residentLimit = 0; },
    c => { c.residentLimit = '3'; },
    c => { c.residentLimit = 1.5; },
    c => { c.employeeLimit = 2; c.residentLimit = 3; },
    c => { c.ownerSecretArn = c.ownerSecretArn.replace('example/owner', '/perottino-co/github/pat'); },
    c => { c.bedrockResourceArns.push('*'); },
    c => { c.customDomain = { hostname: 'test.example.com', certificateArn: '*' }; },
    c => { c.permissionsBoundaryArn += '*'; },
  ]) { const conf = sample(); change(conf); assert.throws(() => render(t, conf), /Invalid hosted configuration/); }
  const prov = fixture('example-provenance.json'); prov.tags['factory:environment'] = 'very-long-environment-name';
  assert.throws(() => render(t, sample(), prov), /function-name limit/);
});

test('scheduled repair and task-stop recovery are limited to the infrastructure entry point', t => {
  const r = render(t).template.Resources;
  const stopped = props(r, 'StoppedWork');
  assert.equal(stopped.ScheduleExpression, undefined);
  assert.deepEqual(stopped.EventPattern.detail, {
    clusterArn: [att('Cluster', 'Arn')], lastStatus: ['STOPPED'], group: [{ prefix: 'employee-' }],
  });
  assert.deepEqual(stopped.Targets[0].Arn, att('FactoryFn', 'Arn'));
  const transformer = stopped.Targets[0].InputTransformer;
  assert.deepEqual(Object.keys(transformer.InputPathsMap).sort(), ['cluster', 'group', 'task']);
  assert.doesNotMatch(transformer.InputTemplate, /override|capability|credential/i);
  assert.equal(props(r, 'RepairRule').ScheduleExpression, 'rate(5 minutes)');
  for (const [permission, id] of [['StoppedInvoke', 'StoppedWork'], ['RepairInvoke', 'RepairRule']]) {
    assert.deepEqual(props(r, permission).SourceArn, att(id, 'Arn'));
    assert.equal(props(r, permission).Principal, 'events.amazonaws.com');
    assert.deepEqual(props(r, permission).FunctionName, att('FactoryFn', 'Arn'));
  }
});

test('the resident task runs at the configured size with no incoming network connections', t => {
  const r = render(t).template.Resources;
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
  assert.deepEqual(worker.Command, ['node', 'src/resident.mjs']);
  const vars = Object.fromEntries(worker.Environment.map(v => [v.Name, v.Value]));
  assert.equal(vars.PEROTTINO_RESIDENT, '1');
  assert.equal(vars.PEROTTINO_COMPANY_GATE, '1');
  assert.match(vars.PEROTTINO_FACTORY_MANAGER_ARN, /-r-m$/);
  assert.equal(vars.PEROTTINO_EMPLOYEE_CAPABILITY, undefined);
  assert.equal(props(r, 'WorkerSecurityGroup').SecurityGroupIngress, undefined);
  assert.deepEqual(props(r, 'WorkerSecurityGroup').SecurityGroupEgress.map(e => e.ToPort), [80, 443]);
});

test('only the trusted Git worker can read the configured writer and reviewer secrets', t => {
  const config = sample();
  const { projectsGitSecretArn:writer, projectsGitReviewerSecretArn:reviewer, ...withoutGit } = config;
  for (const [options, expected] of [[withoutGit,[]],[{...withoutGit,projectsGitSecretArn:writer},[writer]],[config,[writer,reviewer]]]) {
    const r = render(t, options).template.Resources;
    const vars = props(r,'GitFn').Environment.Variables;
    assert.equal(vars.PEROTTINO_PROJECTS_GIT_SECRET_ARN, options.projectsGitSecretArn);
    assert.equal(vars.PEROTTINO_PROJECTS_GIT_REVIEWER_SECRET_ARN, options.projectsGitReviewerSecretArn);
    assert.deepEqual(grants(r,'GitRole').filter(s=>s.Action==='secretsmanager:GetSecretValue').map(s=>s.Resource),expected);
    for (const [id,resource] of Object.entries(r)) {
      if (id !== 'GitRole' && id !== 'GitFn') {
        assert.ok(!JSON.stringify(resource).includes(reviewer),id);
        assert.ok(!JSON.stringify(resource).includes(writer),id);
      }
    }
  }
  for (const arn of [writer,config.ownerSecretArn,reviewer.replace(config.account,'222222222222'),
    reviewer.replace(config.region,'us-west-2'),reviewer+'*']) {
    assert.throws(()=>render(t,{...config,projectsGitReviewerSecretArn:arn}),/projectsGitReviewerSecretArn/);
  }
  assert.throws(()=>render(t,{...withoutGit,projectsGitReviewerSecretArn:reviewer}),/projectsGitReviewerSecretArn/);
});

test('the owner, employees and trusted control code have disjoint entry points and permissions', t => {
  const config = sample(), r = render(t, config).template.Resources;
  const asserted = [['WebFn', 'a', 'src/cloud-api.handler'], ['FactoryFn', 'f', 'src/factory.handler'],
    ['OwnerFn', 'o', 'src/factory.owner'], ['ManagerFn', 'm', 'src/factory.manager']];
  for (const [id, suffix, handler] of asserted) {
    assert.equal(props(r, id).FunctionName, 'factory-11111111-1111-4111-8111-111111111111-example-r-' + suffix);
    assert.deepEqual(props(r, id).ImageConfig.Command, [handler]);
    assert.deepEqual(props(r, id).Code, { ImageUri: config.lambdaImage });
    assert.equal(props(r, id).Environment.Variables.PEROTTINO_RESIDENT, '1');
  }
  const owner = grants(r, 'WebRole').find(s => s.Action === 'secretsmanager:GetSecretValue');
  assert.equal(owner.Resource, config.ownerSecretArn);
  assert.equal(owner.Condition.StringEquals['aws:ResourceTag/perottino:purpose'], 'owner-verifier');
  for (const id of ['FactoryRole', 'ExecutionRole', 'WorkerRole']) {
    assert.ok(!actions(r, id).includes('secretsmanager:GetSecretValue'));
    assert.equal(props(r, id).PermissionsBoundary, config.permissionsBoundaryArn);
  }
  for (const [id, suffix] of [['WebRole', 'o'], ['WorkerRole', 'm']]) {
    const invoke = grants(r, id).filter(g => g.Action === 'lambda:InvokeFunction');
    assert.equal(invoke.length, 1);
    assert.ok(invoke[0].Resource.endsWith('-r-' + suffix));
    assert.ok(!actions(r, id).some(a => /^(ecs:|iam:PassRole)/.test(a)));
    assert.ok(!actions(r, id).some(action => action.startsWith('dynamodb:')));
  }
  const gate = id => grants(r, id).find(s => s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']?.includes('COMPANY#GATE'));
  assert.equal(gate('WorkerRole'), undefined);
  assert.ok(!actions(r,'WorkerRole').some(action=>action.startsWith('ses:')));
  assert.equal(gate('WebRole'), undefined);
  assert.ok(gate('FactoryRole').Action.includes('dynamodb:PutItem'));
  const factory = grants(r, 'FactoryRole');
  assert.deepEqual(factory.find(s => s.Action === 'ecs:RunTask').Resource, { Ref: 'WorkerTask' });
  assert.deepEqual(factory.find(s => s.Action === 'ecs:ListTasks').Condition.ArnEquals['ecs:cluster'], att('Cluster', 'Arn'));
  const pass = factory.find(s => s.Action === 'iam:PassRole');
  assert.deepEqual(pass.Resource, [att('WorkerRole', 'Arn'), att('ExecutionRole', 'Arn')]);
  assert.equal(pass.Condition.StringEquals['iam:PassedToService'], 'ecs-tasks.amazonaws.com');
  assert.ok(actions(r, 'WorkerRole').includes('bedrock-agentcore:ConnectBrowserAutomationStream'));
  const inferenceGrants = grants(r, 'WorkerRole').filter(s => [s.Action].flat().some(a => a.startsWith('bedrock:')));
  assert.deepEqual(inferenceGrants, [
    { Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Resource: config.bedrockResourceArns },
    { Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: 'arn:aws:bedrock:us-east-1:111111111111:project/default',
      Condition: { ArnEquals: { 'bedrock:ModelArn': 'arn:aws:bedrock:us-east-1:111111111111:inference-profile/us.openai.gpt-6-sol' } } },
  ]);
});

test('only trusted broker endpoints get company storage while every application role can emit scoped telemetry', t => {
  const r = render(t, { ...sample(), traceSampleRate: 0.1 }).template.Resources;
  const variable = id => props(r, id).Environment.Variables;
  const worker = Object.fromEntries(props(r, 'WorkerTask').ContainerDefinitions[0].Environment.map(v => [v.Name, v.Value]));
  for (const [env, service] of [[worker, 'resident'], [variable('WebFn'), 'api'], [variable('FactoryFn'), 'factory'],
    [variable('ManagerFn'), 'factory'], [variable('OwnerFn'), 'factory']]) {
    assert.equal(env.PEROTTINO_SERVICE, service);
    assert.equal(env.PEROTTINO_TELEMETRY, 'aws');
    assert.equal(env.PEROTTINO_FOUNDATIONS, '1');
    assert.equal(env.PEROTTINO_TRACE_SAMPLE_RATE, '0.1');
    assert.match(env.PEROTTINO_SCOPE, /-example$/);
    assert.equal(env.PEROTTINO_RELEASE, fixture('example-provenance.json').tags['factory:last-source-commit']);
  }
  assert.equal(worker.PEROTTINO_STATE_TABLE, undefined);
  assert.equal(variable('WebFn').PEROTTINO_STATE_TABLE, undefined);
  assert.deepEqual(variable('ManagerFn').PEROTTINO_STATE_TABLE, {Ref:'State'});
  const brokerKeys = grants(r,'FactoryRole').flatMap(g => g.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? []);
  assert.ok(brokerKeys.includes('V2#*') && !brokerKeys.includes('*'));
  for (const id of ['WorkerRole','WebRole','FactoryRole']) {
    assert.deepEqual(grants(r,id).filter(g => String(g.Action).includes('xray:')),
      [{Effect:'Allow',Action:'xray:PutTraceSegments',Resource:'*'}]);
  }
  assert.ok(!actions(r, 'ExecutionRole').some(a => a.startsWith('xray:')));
  const log = JSON.parse(props(r,'Stage').AccessLogSettings.Format);
  assert.deepEqual(Object.keys(log).sort(), ['latencyMs','requestId','route','status']);
  assert.equal(props(r,'CompanyDashboard').DashboardName.endsWith('us-east-1-operations'),true);
  assert.equal(props(r,'ResidentFailureAlarm').TreatMissingData,'notBreaching');
  assert.throws(() => render(t, {...sample(), traceSampleRate:2}), /traceSampleRate/);
});

test('a configured company browser allowance gives paid starts only to the metered broker', t => {
  for (const minutes of [0,200]) {
    const {Resources:r} = render(t, {...sample(), browserMinutesPerMonth:minutes}).template;
    const env = props(r,'WorkerTask').ContainerDefinitions[0].Environment;
    assert.deepEqual(env.find(e=>e.Name==='PEROTTINO_BROWSER_VIA_BROKER'), {Name:'PEROTTINO_BROWSER_VIA_BROKER',Value:'1'});
    assert.ok(!actions(r,'WorkerRole').some(a=>a.startsWith('bedrock-agentcore:')));
    assert.ok(!actions(r,'WebRole').includes('bedrock-agentcore:StartBrowserSession'));
    assert.ok(actions(r,'FactoryRole').includes('bedrock-agentcore:StartBrowserSession'));
    for (const fn of ['OwnerFn','ManagerFn']) assert.equal(props(r,fn).Environment.Variables.PEROTTINO_BROWSER_MONTHLY_MINUTES,String(minutes));
  }
  assert.throws(()=>render(t,{...sample(),browserMinutesPerMonth:-1}),/browserMinutesPerMonth/);
  assert.throws(()=>render(t,{...sample(),browserMinutesPerMonth:'200'}),/browserMinutesPerMonth/);
});
