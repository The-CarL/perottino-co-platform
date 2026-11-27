import { App, CfnOutput, CfnResource, LegacyStackSynthesizer, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { resourceTags } from './foundation.mjs';
import { isValidEmployeeLimit, maxCompanyEmployees } from '../src/headcount.mjs';

const taggedIds = ['Hosted', 'State', 'Logs', 'WorkerSecurityGroup', 'Cluster', 'WorkerTask', 'ExecutionRole',
  'WorkerRole', 'WebRole', 'FactoryRole', 'WebFn', 'FactoryFn', 'OwnerFn', 'ManagerFn',
  'RepairRule', 'StoppedWork', 'HttpApi', 'Stage', 'Domain'];

const workerSizes = { small: ['256', '1024'], medium: ['512', '1024'], large: ['1024', '2048'] };

function requireField(condition, key) {
  if (!condition) throw new Error('Invalid hosted configuration: ' + key);
}

function validate(c) {
  const { account, region, ownerSecretArn, bedrockModel } = c;
  const employeeLimit = c.employeeLimit ?? maxCompanyEmployees;
  requireField(isValidEmployeeLimit(employeeLimit), `employeeLimit (1 to ${maxCompanyEmployees})`);
  requireField(Object.hasOwn(workerSizes, c.workerSize ?? 'small'), 'workerSize (small, medium, large)');
  requireField(typeof account === 'string' && /^\d{12}$/.test(account), 'account');
  requireField(/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d+$/.test(region), 'commercial AWS region');
  requireField(/^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(c.vpcId), 'vpcId');
  const subnets = c.publicSubnetIds;
  requireField(Array.isArray(subnets) && subnets.length > 0 && subnets.length <= 16
    && new Set(subnets).size === subnets.length && subnets.every(id => /^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id)),
  'distinct publicSubnetIds in the selected VPC');
  const source = account + '.dkr.ecr.' + region + '.amazonaws.com/';
  const repos = [c.workerImage, c.lambdaImage].map(uri => {
    requireField(typeof uri === 'string' && uri.startsWith(source), 'destination ECR account and region');
    const match = /^([a-z0-9]+(?:[._/-][a-z0-9]+)*)@sha256:[0-9a-f]{64}$/.exec(uri.slice(source.length));
    requireField(match, 'image digest and repository');
    return match[1];
  });
  requireField(repos[0] === repos[1] && c.workerImage !== c.lambdaImage, 'separate worker and Lambda digests in one ECR repository');
  requireField(new RegExp('^arn:aws:secretsmanager:' + region + ':' + account + ':secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$').test(ownerSecretArn)
    && !/:secret:\/?perottino-co\/github\/pat-[A-Za-z0-9]{6}$/.test(ownerSecretArn), 'full owner verifier ARN, distinct from the Git secret');
  requireField(new RegExp('^arn:aws:iam::' + account + ':policy/[A-Za-z0-9/+=,.@_-]+$').test(c.permissionsBoundaryArn), 'permissionsBoundaryArn');
  requireField(/^(?:us|global)\.openai\.[a-z0-9.-]+$/.test(bedrockModel), 'Codex Bedrock model');
  const profile = 'arn:aws:bedrock:' + region + ':' + account + ':inference-profile/' + bedrockModel;
  const destinations = c.bedrockResourceArns;
  requireField(Array.isArray(destinations) && destinations.includes(profile) && new Set(destinations).size === destinations.length
    && destinations.length > 1 && destinations.every(arn => arn === profile
      || (/^arn:aws:bedrock:[a-z]{2}-[a-z]+-\d+::foundation-model\/[a-z0-9.-]+$/.test(arn)
        && arn.endsWith('/' + bedrockModel.slice(bedrockModel.indexOf('.') + 1)))), 'exact inference profile and destination model ARNs');
  if (c.customDomain !== undefined) {
    const { hostname, certificateArn, hostedZoneId } = c.customDomain;
    requireField(typeof hostname === 'string' && hostname.length <= 253
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname), 'customDomain.hostname');
    requireField(new RegExp('^arn:aws:acm:' + region + ':' + account + ':certificate/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$').test(certificateArn), 'same-region certificateArn');
    if (hostedZoneId !== undefined) requireField(/^Z[A-Z0-9]+$/.test(hostedZoneId), 'hostedZoneId');
  }
  return 'arn:aws:ecr:' + region + ':' + account + ':repository/' + repos[0];
}

export function synthHosted(config, provenance, outdir) {
  const repo = validate(config);
  const tags = resourceTags(provenance, taggedIds);
  const scope = tags.Hosted['factory:s'];
  const prefix = 'factory-' + scope + '-r-';
  requireField(prefix.length + 1 <= 64, 'project scope exceeds the Lambda function-name limit');
  const { account, region } = config;
  const app = new App({ outdir, autoSynth: false, analyticsReporting: false, treeMetadata: false });
  const stack = new Stack(app, 'Hosted', { stackName: prefix + 'events', env: { account, region }, terminationProtection: true,
    synthesizer: new LegacyStackSynthesizer(), description: 'HTTPS owner console, bounded recruiting and resident employee tasks' });
  for (const [key, value] of Object.entries(tags.Hosted)) stack.tags.setTag(key, value);
  function resource(id, type, properties, tagMap = false) {
    if (tags[id]) properties.Tags = tagMap ? tags[id] : Object.entries(tags[id]).map(([Key, Value]) => ({ Key, Value }));
    return new CfnResource(stack, id, { type: type.startsWith('Custom::') ? type : 'AWS::' + type, properties });
  }
  const arn = item => item.getAtt('Arn').toString();
  const retain = item => { item.applyRemovalPolicy(RemovalPolicy.RETAIN); return item; };
  const allow = (Action, Resource) => ({ Effect: 'Allow', Action, Resource });
  const scopeTags = purpose => ({ StringEquals: { 'aws:ResourceTag/factory:s': scope, 'aws:ResourceTag/perottino:purpose': purpose } });
  const state = retain(resource('State', 'DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST', DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
  }));
  const logs = retain(resource('Logs', 'Logs::LogGroup', { LogGroupName: '/factory/' + scope + '/events', RetentionInDays: 14 }));
  const sg = resource('WorkerSecurityGroup', 'EC2::SecurityGroup', { GroupDescription: 'Outbound HTTPS from employee tasks',
    VpcId: config.vpcId, SecurityGroupEgress: [80, 443].map(port => ({ IpProtocol: 'tcp', FromPort: port, ToPort: port, CidrIp: '0.0.0.0/0' })) });
  const clusterName = prefix + 'employees';
  const cluster = resource('Cluster', 'ECS::Cluster', { ClusterName: clusterName });
  const api = resource('HttpApi', 'ApiGatewayV2::Api', { Name: prefix + 'owner', ProtocolType: 'HTTP',
    DisableExecuteApiEndpoint: Boolean(config.customDomain) }, true);
  const publicOrigin = config.customDomain ? 'https://' + config.customDomain.hostname : api.getAtt('ApiEndpoint').toString();

  function role(id, service, statements, sourceArn) {
    const trust = { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: service } };
    if (sourceArn) trust.Condition = { StringEquals: { 'aws:SourceAccount': account }, ArnLike: { 'aws:SourceArn': sourceArn } };
    return resource(id, 'IAM::Role', { Path: '/factory/' + scope + '/', PermissionsBoundary: config.permissionsBoundaryArn,
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [trust] }, Policies: [{ PolicyName: 'Workload',
        PolicyDocument: { Version: '2012-10-17', Statement: statements } }] });
  }
  const logWrite = allow(['logs:CreateLogStream', 'logs:PutLogEvents'], arn(logs));
  const read = ['dynamodb:GetItem', 'dynamodb:Query'];
  const write = [...read, 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem'];
  const ecs = 'ecs-tasks.amazonaws.com', lambda = 'lambda.amazonaws.com';
  const ecsArn = 'arn:aws:ecs:' + region + ':' + account + ':';
  const browser = 'arn:aws:bedrock-agentcore:' + region + ':aws:browser/aws.browser.v1';
  const executionRole = role('ExecutionRole', ecs, [logWrite, allow('ecr:GetAuthorizationToken', '*'),
    { ...allow(['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'], repo),
      Condition: scopeTags('runtime-images') }], ecsArn + '*');
  // Build these two ARNs by the deterministic Lambda name to avoid an IAM/RunTask
  // reference cycle. Each caller may invoke only its own entry point.
  const functionArn = suffix => 'arn:aws:lambda:' + region + ':' + account + ':function:' + prefix + suffix;
  const scopedItems = (actions, keys) => ({ ...allow(actions, arn(state)), Condition: {
    'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': keys }, Null: { 'dynamodb:LeadingKeys': 'false' },
  } });
  const employeeState = [scopedItems([...read, 'dynamodb:ConditionCheckItem'], ['DIRECTORY']),
    scopedItems(write, ['AGENT#*'])];
  const workerRole = role('WorkerRole', ecs, [...employeeState, scopedItems(['dynamodb:ConditionCheckItem'], ['COMPANY#GATE']),
    allow('lambda:InvokeFunction', functionArn('m')),
    allow(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], config.bedrockResourceArns),
    allow(['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession',
      'bedrock-agentcore:ConnectBrowserAutomationStream'], browser)], ecsArn + '*');
  const [cpu, memory] = workerSizes[config.workerSize ?? 'small'];
  const workerTask = retain(resource('WorkerTask', 'ECS::TaskDefinition', { Family: prefix + 'worker', NetworkMode: 'awsvpc',
    RequiresCompatibilities: ['FARGATE'], Cpu: cpu, Memory: memory, RuntimePlatform: { OperatingSystemFamily: 'LINUX', CpuArchitecture: 'X86_64' },
    TaskRoleArn: arn(workerRole), ExecutionRoleArn: arn(executionRole), ContainerDefinitions: [{
      Name: 'worker', Image: config.workerImage, User: '1000:1000', Command: ['node', 'src/resident.mjs'],
      Essential: true, StopTimeout: 30, LinuxParameters: { InitProcessEnabled: true, Capabilities: { Drop: ['ALL'] } },
      Environment: Object.entries({ NODE_ENV: 'production', PEROTTINO_RESIDENT: '1', PEROTTINO_COMPANY_GATE: '1', PEROTTINO_STATE_TABLE: state.ref,
        PEROTTINO_FACTORY_MANAGER_ARN: functionArn('m'), PEROTTINO_BEDROCK_MODEL: config.bedrockModel,
        PEROTTINO_BROWSER_ID: 'aws.browser.v1' }).map(([Name, Value]) => ({ Name, Value })),
      LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-region': region, 'awslogs-group': logs.ref, 'awslogs-stream-prefix': 'employee' } },
    }] }));
  function fn(id, suffix, handler, functionRole, variables, timeout = 30) {
    return resource(id, 'Lambda::Function', { FunctionName: prefix + suffix, PackageType: 'Image', Architectures: ['x86_64'],
      Code: { ImageUri: config.lambdaImage }, ImageConfig: { Command: [handler] }, Role: arn(functionRole), Timeout: timeout,
      MemorySize: 512, LoggingConfig: { LogGroup: logs.ref, LogFormat: 'JSON' },
      Environment: { Variables: { NODE_ENV: 'production', ...variables } } });
  }

  const webRole = role('WebRole', lambda, [logWrite, ...employeeState, allow('lambda:InvokeFunction', functionArn('o')),
    { ...allow('secretsmanager:GetSecretValue', config.ownerSecretArn), Condition: scopeTags('owner-verifier') }]);
  const web = fn('WebFn', 'a', 'src/cloud-api.handler', webRole, { PEROTTINO_STATE_TABLE: state.ref, PEROTTINO_RESIDENT: '1',
    PEROTTINO_OWNER_SECRET_ARN: config.ownerSecretArn, PUBLIC_ORIGIN: publicOrigin, PEROTTINO_FACTORY_OWNER_ARN: functionArn('o') }, 28);

  const taskArnPattern = ecsArn + 'task/' + clusterName + '/*';
  const sameCluster = { ArnEquals: { 'ecs:cluster': arn(cluster) } };
  const factoryRole = role('FactoryRole', lambda, [logWrite, scopedItems(write, ['DIRECTORY', 'AGENT#*', 'FACTORY#*']),
    scopedItems(['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:ConditionCheckItem'], ['COMPANY#GATE']),
    { ...allow('ecs:RunTask', workerTask.ref), Condition: sameCluster },
    { ...allow('ecs:ListTasks', '*'), Condition: sameCluster },
    allow(['ecs:DescribeTasks', 'ecs:StopTask'], taskArnPattern),
    { ...allow('ecs:TagResource', taskArnPattern), Condition: { StringEquals: { 'ecs:CreateAction': 'RunTask' } } },
    { ...allow('iam:PassRole', [arn(workerRole), arn(executionRole)]), Condition: { StringEquals: { 'iam:PassedToService': ecs } } },
  ]);
  const limit = String(config.employeeLimit ?? maxCompanyEmployees);
  const groupId = sg.getAtt('GroupId').toString();
  const factoryConfig = { PEROTTINO_RESIDENT: '1', PEROTTINO_COMPANY_GATE: '1', PEROTTINO_STATE_TABLE: state.ref,
    PEROTTINO_CLUSTER_ARN: arn(cluster), PEROTTINO_TASK_DEFINITION_ARN: workerTask.ref,
    PEROTTINO_PUBLIC_SUBNET_IDS: config.publicSubnetIds.join(','), PEROTTINO_SECURITY_GROUP_ID: groupId,
    PEROTTINO_EMPLOYEE_LIMIT: limit };
  const factory = fn('FactoryFn', 'f', 'src/factory.handler', factoryRole, factoryConfig, 240);
  const owner = fn('OwnerFn', 'o', 'src/factory.owner', factoryRole, factoryConfig, 60);
  const manager = fn('ManagerFn', 'm', 'src/factory.manager', factoryRole, factoryConfig, 60);
  const retry = { MaximumEventAgeInSeconds: 600, MaximumRetryAttempts: 3 };
  const stopped = resource('StoppedWork', 'Events::Rule', { Name: prefix + 'x', State: 'ENABLED',
    EventPattern: { source: ['aws.ecs'], 'detail-type': ['ECS Task State Change'], detail: {
      clusterArn: [arn(cluster)], lastStatus: ['STOPPED'], group: [{ prefix: 'employee-' }],
    } },
    // ECS events can carry launch overrides. Only these four binding/status fields
    // go to application code, so per-generation capabilities stay out of the event.
    Targets: [{ Id: 'Factory', Arn: arn(factory), RetryPolicy: retry, InputTransformer: {
      InputPathsMap: { cluster: '$.detail.clusterArn', task: '$.detail.taskArn', group: '$.detail.group' },
      InputTemplate: '{"source":"aws.ecs","detail":{"clusterArn":<cluster>,"taskArn":<task>,"group":<group>,"lastStatus":"STOPPED"}}',
    } }] });
  const repair = resource('RepairRule', 'Events::Rule', { Name: prefix + 'p', State: 'ENABLED', ScheduleExpression: 'rate(5 minutes)',
    Targets: [{ Id: 'Factory', Arn: arn(factory), RetryPolicy: retry }] });
  function invokePermission(id, rule) {
    return resource(id, 'Lambda::Permission', { FunctionName: arn(factory), Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com', SourceArn: arn(rule), SourceAccount: account });
  }
  // During deletion, the callback quiesces the full company while IAM, both rules
  // and the task definition still exist. Late events must check the durable stop.
  const bootstrap = resource('ResidentCompany', 'Custom::ResidentCompany', {
    ServiceToken: arn(factory), ServiceTimeout: 300, EmployeeLimit: limit, TaskDefinitionArn: workerTask.ref,
    SecurityGroupId: groupId, PublicSubnetIds: config.publicSubnetIds, WorkerImage: config.workerImage, ReleaseImage: config.lambdaImage,
  });
  for (const dependency of [invokePermission('StoppedInvoke', stopped), invokePermission('RepairInvoke', repair), manager, owner]) {
    bootstrap.addDependency(dependency);
  }
  const integration = resource('ApiIntegration', 'ApiGatewayV2::Integration', { ApiId: api.ref, IntegrationType: 'AWS_PROXY',
    IntegrationUri: arn(web), PayloadFormatVersion: '2.0', TimeoutInMillis: 29000 });
  resource('DefaultRoute', 'ApiGatewayV2::Route', { ApiId: api.ref, RouteKey: '$default', Target: 'integrations/' + integration.ref });
  const stage = resource('Stage', 'ApiGatewayV2::Stage', { ApiId: api.ref, StageName: '$default', AutoDeploy: true,
    DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 } }, true);
  resource('ApiInvoke', 'Lambda::Permission', { FunctionName: arn(web), Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com',
    SourceAccount: account, SourceArn: 'arn:aws:execute-api:' + region + ':' + account + ':' + api.ref + '/*' });
  if (config.customDomain) {
    const { hostname, certificateArn, hostedZoneId } = config.customDomain;
    const domain = resource('Domain', 'ApiGatewayV2::DomainName', { DomainName: hostname,
      DomainNameConfigurations: [{ CertificateArn: certificateArn, EndpointType: 'REGIONAL', SecurityPolicy: 'TLS_1_2' }] }, true);
    resource('DomainMapping', 'ApiGatewayV2::ApiMapping', { ApiId: api.ref, DomainName: domain.ref, Stage: stage.ref });
    const dnsName = domain.getAtt('RegionalDomainName').toString(), zone = domain.getAtt('RegionalHostedZoneId').toString();
    if (hostedZoneId) resource('Dns', 'Route53::RecordSet', { HostedZoneId: hostedZoneId, Name: hostname + '.', Type: 'A',
      AliasTarget: { DNSName: dnsName, HostedZoneId: zone, EvaluateTargetHealth: false } });
    new CfnOutput(stack, 'RegionalDnsName', { value: dnsName });
    new CfnOutput(stack, 'RegionalDnsZone', { value: zone });
  }
  for (const [id, value] of Object.entries({ Url: publicOrigin + '/chat', StateTableName: state.ref, ClusterName: cluster.ref,
    FactoryArn: arn(factory), OwnerFactoryArn: arn(owner) })) new CfnOutput(stack, id, { value });
  return app.synth().getStackArtifact(stack.artifactId);
}
