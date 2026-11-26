import { App, CfnOutput, CfnResource, LegacyStackSynthesizer, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { resourceTags } from './foundation.mjs';
import { turnWorkflow } from './workflow.mjs';

const taggedIds = ['Hosted', 'State', 'Failures', 'Logs', 'WorkerSecurityGroup', 'Cluster', 'WorkerTask',
  'ExecutionRole', 'WorkerRole', 'WebRole', 'DispatchRole', 'AdmissionRole', 'TerminalRole', 'WorkflowRole',
  'WebFn', 'DispatchFn', 'AdmissionFn', 'TerminalFn', 'Workflow', 'StreamMapping', 'HttpApi', 'Stage', 'Domain', 'RecoveryQueue', 'StoppedWork'];

const workerSizes = { small: ['256', '1024'], medium: ['512', '1024'], large: ['1024', '2048'] };

function requireField(condition, key) {
  if (!condition) throw new Error('Invalid hosted configuration: ' + key);
}

function validate(c) {
  const { account, region, ownerSecretArn, bedrockModel } = c;
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
    synthesizer: new LegacyStackSynthesizer(), description: 'HTTPS owner console, persistent message queue and on-demand employee turns' });
  for (const [key, value] of Object.entries(tags.Hosted)) stack.tags.setTag(key, value);
  function resource(id, type, properties, tagMap = false) {
    if (tags[id]) properties.Tags = tagMap ? tags[id] : Object.entries(tags[id]).map(([Key, Value]) => ({ Key, Value }));
    return new CfnResource(stack, id, { type: 'AWS::' + type, properties });
  }
  const arn = item => item.getAtt('Arn').toString();
  const retain = item => { item.applyRemovalPolicy(RemovalPolicy.RETAIN); return item; };
  const allow = (Action, Resource) => ({ Effect: 'Allow', Action, Resource });
  const scopeTags = purpose => ({ StringEquals: { 'aws:ResourceTag/factory:s': scope, 'aws:ResourceTag/perottino:purpose': purpose } });
  const state = retain(resource('State', 'DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST', DeletionProtectionEnabled: true, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
  }));
  const failures = retain(resource('Failures', 'S3::Bucket', {
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] }, VersioningConfiguration: { Status: 'Enabled' },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  }));
  retain(resource('FailurePolicy', 'S3::BucketPolicy', { Bucket: failures.ref, PolicyDocument: { Version: '2012-10-17', Statement: [
    { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [arn(failures), arn(failures) + '/*'],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
  ] } }));
  const logs = retain(resource('Logs', 'Logs::LogGroup', { LogGroupName: '/factory/' + scope + '/events', RetentionInDays: 14 }));
  const sg = resource('WorkerSecurityGroup', 'EC2::SecurityGroup', { GroupDescription: 'Outbound HTTPS from employee tasks',
    VpcId: config.vpcId, SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }] });
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
  const workerRole = role('WorkerRole', ecs, [allow(write, arn(state)),
    allow(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], config.bedrockResourceArns),
    allow(['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession',
      'bedrock-agentcore:ConnectBrowserAutomationStream'], browser)], ecsArn + '*');
  const [cpu, memory] = workerSizes[config.workerSize ?? 'small'];
  const workerTask = resource('WorkerTask', 'ECS::TaskDefinition', { Family: prefix + 'worker', NetworkMode: 'awsvpc',
    RequiresCompatibilities: ['FARGATE'], Cpu: cpu, Memory: memory, RuntimePlatform: { OperatingSystemFamily: 'LINUX', CpuArchitecture: 'X86_64' },
    TaskRoleArn: arn(workerRole), ExecutionRoleArn: arn(executionRole), ContainerDefinitions: [{
      Name: 'worker', Image: config.workerImage, User: '1000:1000', Command: ['node', 'src/cloud-worker.mjs'],
      Essential: true, StopTimeout: 30, LinuxParameters: { InitProcessEnabled: true, Capabilities: { Drop: ['ALL'] } },
      Environment: Object.entries({ NODE_ENV: 'production', PEROTTINO_STATE_TABLE: state.ref, PEROTTINO_BEDROCK_MODEL: config.bedrockModel,
        PEROTTINO_BROWSER_ID: 'aws.browser.v1' }).map(([Name, Value]) => ({ Name, Value })),
      LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-region': region, 'awslogs-group': logs.ref, 'awslogs-stream-prefix': 'employee' } },
    }] });
  function fn(id, suffix, handler, functionRole, variables, timeout = 30) {
    return resource(id, 'Lambda::Function', { FunctionName: prefix + suffix, PackageType: 'Image', Architectures: ['x86_64'],
      Code: { ImageUri: config.lambdaImage }, ImageConfig: { Command: [handler] }, Role: arn(functionRole), Timeout: timeout,
      MemorySize: 512, LoggingConfig: { LogGroup: logs.ref, LogFormat: 'JSON' },
      Environment: { Variables: { NODE_ENV: 'production', ...variables } } });
  }

  const webRole = role('WebRole', lambda, [logWrite, allow(write, arn(state)),
    { ...allow('secretsmanager:GetSecretValue', config.ownerSecretArn), Condition: scopeTags('owner-verifier') }]);
  const web = fn('WebFn', 'a', 'src/cloud-api.handler', webRole, { PEROTTINO_STATE_TABLE: state.ref,
    PEROTTINO_OWNER_SECRET_ARN: config.ownerSecretArn, PUBLIC_ORIGIN: publicOrigin }, 28);
  const admission = fn('AdmissionFn', 'i', 'src/dispatch.admit', role('AdmissionRole', lambda, [logWrite, allow(read, arn(state))]),
    { PEROTTINO_STATE_TABLE: state.ref });
  const terminal = fn('TerminalFn', 't', 'src/dispatch.terminal', role('TerminalRole', lambda, [logWrite,
    allow(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'], arn(state))]), { PEROTTINO_STATE_TABLE: state.ref });
  const workflowName = prefix + 'turn';
  const machineArn = 'arn:aws:states:' + region + ':' + account + ':stateMachine:' + workflowName;
  const managedRule = 'arn:aws:events:' + region + ':' + account + ':rule/StepFunctionsGetEventsForECSTaskRule';
  const taskArnPattern = ecsArn + 'task/' + clusterName + '/*';
  const workflowRole = role('WorkflowRole', 'states.amazonaws.com', [
    allow('lambda:InvokeFunction', [arn(admission), arn(terminal)]),
    { ...allow('ecs:RunTask', workerTask.ref), Condition: { ArnEquals: { 'ecs:cluster': arn(cluster) } } },
    { ...allow('ecs:TagResource', taskArnPattern), Condition: { StringEquals: { 'ecs:CreateAction': 'RunTask' } } },
    allow(['ecs:DescribeTasks', 'ecs:StopTask'], taskArnPattern),
    { ...allow('iam:PassRole', [arn(workerRole), arn(executionRole)]), Condition: { StringEquals: { 'iam:PassedToService': ecs } } },
    allow(['events:PutRule', 'events:PutTargets', 'events:DescribeRule'], managedRule),
    allow('s3:PutObject', arn(failures) + '/workflow-failures/*'),
  ], machineArn);
  const machine = resource('Workflow', 'StepFunctions::StateMachine', { StateMachineName: workflowName, StateMachineType: 'STANDARD',
    RoleArn: arn(workflowRole), Definition: turnWorkflow({ cluster: arn(cluster), task: workerTask.ref, subnets: config.publicSubnetIds,
      securityGroup: sg.getAtt('GroupId').toString(), admit: arn(admission), terminal: arn(terminal), failureBucket: failures.ref }) });
  // Standard workflow timeouts and manual aborts bypass the workflow's own Catch path.
  // Store only IDs/status for operators; keep prompts out of the EventBridge target.
  const recovery = retain(resource('RecoveryQueue', 'SQS::Queue', { SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 }));
  const ruleName = prefix + 'x';
  const recoveryPolicy = retain(resource('RecoveryPolicy', 'SQS::QueuePolicy', { Queues: [recovery.ref], PolicyDocument: {
    Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: arn(recovery),
        Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:events:' + region + ':' + account + ':rule/' + ruleName } } },
      { Effect: 'Deny', Principal: '*', Action: 'sqs:*', Resource: arn(recovery), Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    ],
  } }));
  const stoppedRule = resource('StoppedWork', 'Events::Rule', { Name: ruleName, State: 'ENABLED', EventPattern: {
    source: ['aws.states'], 'detail-type': ['Step Functions Execution Status Change'],
    detail: { stateMachineArn: [machine.ref], status: ['FAILED', 'ABORTED', 'TIMED_OUT'] },
  }, Targets: [{ Id: 'Recovery', Arn: arn(recovery), InputTransformer: { InputPathsMap: {
    execution: '$.detail.executionArn', status: '$.detail.status', name: '$.detail.name',
  }, InputTemplate: '{"executionArn":<execution>,"status":<status>,"name":<name>}' } }] });
  stoppedRule.addDependency(recoveryPolicy);
  const streamArn = state.getAtt('StreamArn').toString();
  const dispatchRole = role('DispatchRole', lambda, [logWrite, allow('states:StartExecution', machine.ref),
    allow(['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'], streamArn), allow('dynamodb:ListStreams', '*'),
    { ...allow('s3:ListBucket', arn(failures)), Condition: { StringEquals: { 's3:ResourceAccount': account } } },
    { ...allow('s3:PutObject', arn(failures) + '/*'), Condition: { StringEquals: { 's3:ResourceAccount': account } } },
  ]);
  const dispatcher = fn('DispatchFn', 'd', 'src/dispatch.handler', dispatchRole, { PEROTTINO_STATE_MACHINE_ARN: machine.ref });
  resource('StreamMapping', 'Lambda::EventSourceMapping', { EventSourceArn: streamArn, FunctionName: arn(dispatcher),
    StartingPosition: 'TRIM_HORIZON', BatchSize: 10, Enabled: true, BisectBatchOnFunctionError: true, MaximumRetryAttempts: 8,
    MaximumRecordAgeInSeconds: 21600, FunctionResponseTypes: ['ReportBatchItemFailures'],
    FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { NewImage: {
      kind: { S: ['job'] }, state: { S: ['queued'] },
    } } }) }] }, DestinationConfig: { OnFailure: { Destination: arn(failures) } } });
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
  for (const [id, value] of Object.entries({ Url: publicOrigin + '/chat', StateTableName: state.ref, StateMachineArn: machine.ref,
    FailedEventBucket: failures.ref, RecoveryQueueUrl: recovery.ref, ClusterName: cluster.ref })) new CfnOutput(stack, id, { value });
  return app.synth().getStackArtifact(stack.artifactId);
}
