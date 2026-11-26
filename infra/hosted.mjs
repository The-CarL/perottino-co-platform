import { readFileSync } from 'node:fs';
import { App, CfnOutput, CfnParameter, CfnResource, Fn, LegacyStackSynthesizer, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { resourceTags } from './foundation.mjs';

const taggedIds = ['Hosted', 'Data', 'Address', 'SecurityGroup', 'Cluster', 'Logs', 'HostRole',
  'WebRole', 'WorkerRole', 'WebExecution', 'WorkerExecution', 'Host', 'ConsoleTask', 'WorkerTask',
  'ConsoleService', 'WorkerService', 'ContainerInstance', 'RenderExecution', 'RendererTask', 'RendererService'];

function requireField(condition, key) {
  if (!condition) throw new Error('Invalid hosted configuration: ' + key);
}

function validate(c) {
  const { account, region, ownerSecretArn, workerSecretArn, bedrockModel } = c;
  requireField(/^\d{12}$/.test(account) && typeof account === 'string', 'account');
  requireField(/^(us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d+$/.test(region), 'commercial AWS region');
  for (const [key, prefix] of [['vpcId', 'vpc'], ['publicSubnetId', 'subnet'], ['amiId', 'ami']]) {
    requireField(new RegExp('^' + prefix + '-(?:[0-9a-f]{8}|[0-9a-f]{17})$').test(c[key]), key);
  }
  requireField(new RegExp('^' + region + '[a-z]$').test(c.availabilityZone), 'availabilityZone');
  requireField(typeof c.hostname === 'string' && c.hostname.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname), 'hostname');
  if (c.hostedZoneId !== undefined) requireField(/^Z[A-Z0-9]+$/.test(c.hostedZoneId), 'hostedZoneId');
  const imagePrefix = account + '.dkr.ecr.' + region + '.amazonaws.com/';
  const images = [c.appImage, c.proxyImage].map(uri => {
    requireField(typeof uri === 'string' && uri.startsWith(imagePrefix), 'target ECR account and region');
    const match = /^([a-z0-9]+(?:[._/-][a-z0-9]+)*)@sha256:[0-9a-f]{64}$/.exec(uri.slice(imagePrefix.length));
    requireField(match, 'image digest and repository');
    return match[1];
  });
  requireField(images[0] === images[1] && c.appImage !== c.proxyImage, 'distinct images in one repository');
  const secretPattern = new RegExp('^arn:aws:secretsmanager:' + region + ':' + account + ':secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$');
  requireField(secretPattern.test(ownerSecretArn) && secretPattern.test(workerSecretArn)
    && ownerSecretArn !== workerSecretArn
    && [ownerSecretArn, workerSecretArn].every(arn => !/:secret:\/?perottino-co\/github\/pat-[A-Za-z0-9]{6}$/.test(arn)),
  'distinct full owner and worker secret ARNs excluding the Git credential');
  requireField(new RegExp('^arn:aws:iam::' + account + ':policy/[A-Za-z0-9/+=,.@_-]+$').test(c.permissionsBoundaryArn),
    'same-account IAM permissions boundary');
  requireField(/^(?:us|global)\.openai\.[a-z0-9.-]+$/.test(bedrockModel), 'Codex Bedrock model');
  const profileArn = 'arn:aws:bedrock:' + region + ':' + account + ':inference-profile/' + bedrockModel;
  const modelName = bedrockModel.slice(bedrockModel.indexOf('.') + 1);
  requireField(Array.isArray(c.bedrockResourceArns) && c.bedrockResourceArns.includes(profileArn)
    && c.bedrockResourceArns.length > 1 && c.bedrockResourceArns.every(arn => arn === profileArn
      || (/^arn:aws:bedrock:[a-z]{2}-[a-z]+-\d+::foundation-model\/[a-z0-9.-]+$/.test(arn)
        && arn.endsWith('/' + modelName))), 'exact profile and destination model ARNs');
  if (c.dataSnapshotId !== undefined) requireField(/^snap-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(c.dataSnapshotId), 'dataSnapshotId');
  if (c.volumeGiB !== undefined) requireField(Number.isSafeInteger(c.volumeGiB) && c.volumeGiB >= 12 && c.volumeGiB <= 1024, 'volumeGiB');
  if (c.hostState !== undefined) requireField(['running', 'quiesced', 'detached'].includes(c.hostState), 'hostState');
  if (c.instanceType !== undefined) requireField(['t3.medium', 't3.large', 't3.xlarge', 'm6i.large', 'm7i.large'].includes(c.instanceType), 'x86_64 Nitro instanceType');
  return 'arn:aws:ecr:' + region + ':' + account + ':repository/' + images[0];
}

export function synthHosted(config, provenance, outdir) {
  const repositoryArn = validate(config);
  const tags = resourceTags(provenance, taggedIds);
  const scope = tags.Hosted['factory:s'];
  const prefix = 'factory-' + scope + '-r-';
  const app = new App({ outdir, autoSynth: false, analyticsReporting: false, treeMetadata: false });
  const stack = new Stack(app, 'Hosted', { stackName: prefix + 'hosted',
    env: { account: config.account, region: config.region }, terminationProtection: true,
    synthesizer: new LegacyStackSynthesizer(), description: 'Single-host HTTPS owner console and isolated inference worker',
  });
  for (const [key, value] of Object.entries(tags.Hosted)) stack.tags.setTag(key, value);

  function resource(id, type, properties) {
    if (tags[id]) properties.Tags = Object.entries(tags[id]).map(([Key, Value]) => ({ Key, Value }));
    return new CfnResource(stack, id, { type: 'AWS::' + type, properties });
  }
  function retain(item) {
    item.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return item;
  }
  const attr = (item, key) => item.getAtt(key).toString();
  const allow = (Action, Resource) => ({ Effect: 'Allow', Action, Resource });
  const cluster = resource('Cluster', 'ECS::Cluster', { ClusterName: prefix + 'company' });
  const logs = retain(resource('Logs', 'Logs::LogGroup', {
    LogGroupName: '/factory/' + scope + '/hosted', RetentionInDays: 14,
  }));
  const zone = new CfnParameter(stack, 'DataAvailabilityZone', {
    type: 'AWS::EC2::AvailabilityZone::Name', default: config.availabilityZone, allowedValues: [config.availabilityZone],
    description: 'Availability zone of the imported public subnet and retained volume',
  }).valueAsString;
  const data = retain(resource('Data', 'EC2::Volume', {
    AvailabilityZone: zone, Size: config.volumeGiB ?? 24,
    VolumeType: 'gp3', Encrypted: true, ...(config.dataSnapshotId && { SnapshotId: config.dataSnapshotId }),
  }));
  const address = retain(resource('Address', 'EC2::EIP', { Domain: 'vpc' }));
  const sg = resource('SecurityGroup', 'EC2::SecurityGroup', {
    GroupDescription: 'Only public HTTP ACME and HTTPS reach the Caddy proxy',
    VpcId: config.vpcId,
    SecurityGroupIngress: [80, 443].map(port => ({ IpProtocol: 'tcp', FromPort: port, ToPort: port, CidrIp: '0.0.0.0/0' })),
    SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }],
  });

  const region = config.region;
  const account = config.account;
  function role(id, service, statements = []) {
    const trust = { Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' };
    if (service === 'ecs-tasks.amazonaws.com') trust.Condition = {
      StringEquals: { 'aws:SourceAccount': account }, ArnLike: { 'aws:SourceArn': 'arn:aws:ecs:' + region + ':' + account + ':*' },
    };
    return resource(id, 'IAM::Role', { Path: '/factory/' + scope + '/', PermissionsBoundary: config.permissionsBoundaryArn,
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [trust] },
      ...(statements.length && { Policies: [{ PolicyName: 'Workload', PolicyDocument: { Version: '2012-10-17', Statement: statements } }] }),
    });
  }
  const taggedAccess = (action, arn, purpose) => ({ ...allow(action, arn), Condition: { StringEquals: {
    'aws:ResourceTag/factory:s': scope, 'aws:ResourceTag/perottino:purpose': purpose,
  } } });
  const pull = [allow('ecr:GetAuthorizationToken', '*'), taggedAccess([
    'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
  ], repositoryArn, 'runtime-images')];
  const clusterArn = attr(cluster, 'Arn');
  const instances = 'arn:aws:ecs:' + region + ':' + account + ':container-instance/' + prefix + 'company/*';
  const hostRole = role('HostRole', 'ec2.amazonaws.com', [
    ...pull, allow('ecs:DiscoverPollEndpoint', '*'),
    allow(['ecs:RegisterContainerInstance', 'ecs:DeregisterContainerInstance', 'ecs:SubmitAttachmentStateChanges',
      'ecs:SubmitContainerStateChange', 'ecs:SubmitTaskStateChange'], clusterArn),
    { ...allow(['ecs:Poll', 'ecs:StartTelemetrySession'], instances), Condition: { ArnEquals: { 'ecs:cluster': clusterArn } } },
    { ...allow('ecs:TagResource', instances), Condition: { StringEquals: {
      'ecs:CreateAction': 'RegisterContainerInstance', 'aws:RequestTag/factory:s': scope,
    } } },
  ]);
  const profile = resource('HostProfile', 'IAM::InstanceProfile', { Path: '/factory/' + scope + '/', Roles: [hostRole.ref] });
  const exec = [...pull, allow(['logs:CreateLogStream', 'logs:PutLogEvents'], attr(logs, 'Arn'))];
  const renderExec = role('RenderExecution', 'ecs-tasks.amazonaws.com', exec);
  const webExec = role('WebExecution', 'ecs-tasks.amazonaws.com', [
    ...exec, taggedAccess('secretsmanager:GetSecretValue', config.ownerSecretArn, 'owner-verifier'),
    taggedAccess('secretsmanager:GetSecretValue', config.workerSecretArn, 'worker-token'),
  ]);
  const workerExec = role('WorkerExecution', 'ecs-tasks.amazonaws.com', [
    ...exec, taggedAccess('secretsmanager:GetSecretValue', config.workerSecretArn, 'worker-token'),
  ]);
  const webRole = role('WebRole', 'ecs-tasks.amazonaws.com');
  const workerRole = role('WorkerRole', 'ecs-tasks.amazonaws.com', [
    allow(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], config.bedrockResourceArns),
  ]);

  const script = readFileSync(new URL('./host-bootstrap.sh', import.meta.url), 'utf8')
    .replace('@@CLUSTER@@', cluster.ref).replace('@@VOLUME@@', data.ref)
    .replace('@@BOOT_TIMEOUT@@', String(Math.max(1800, (config.volumeGiB ?? 24) * 64 + 600)))
    .replace('@@INSTANCE_TAGS@@', JSON.stringify(tags.ContainerInstance))
    .replace('@@ALLOW_FORMAT@@', config.dataSnapshotId ? 'no' : 'yes');
  const detached = config.hostState === 'detached';
  const host = !detached && resource('Host', 'EC2::Instance', {
    ImageId: config.amiId, InstanceType: config.instanceType ?? 't3.medium',
    AvailabilityZone: zone, SubnetId: config.publicSubnetId,
    SecurityGroupIds: [attr(sg, 'GroupId')], IamInstanceProfile: profile.ref,
    MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled', HttpProtocolIpv6: 'disabled' },
    BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeType: 'gp3', VolumeSize: 40, Encrypted: true, DeleteOnTermination: true } }],
    PropagateTagsToVolumeOnCreation: true, UserData: Fn.base64(script),
  });
  const attachment = !detached && resource('Mount', 'EC2::VolumeAttachment', { VolumeId: data.ref, InstanceId: host.ref, Device: '/dev/sdf' });
  const association = !detached && resource('IpBinding', 'EC2::EIPAssociation', { AllocationId: attr(address, 'AllocationId'), InstanceId: host.ref });
  if (config.hostedZoneId) resource('Dns', 'Route53::RecordSet', {
    HostedZoneId: config.hostedZoneId, Name: config.hostname + '.', Type: 'A', TTL: '60', ResourceRecords: [address.ref],
  });

  const log = name => ({ LogDriver: 'awslogs', Options: {
    'awslogs-region': region, 'awslogs-group': logs.ref, 'awslogs-stream-prefix': name,
  } });
  const env = values => Object.entries(values).map(([Name, Value]) => ({ Name, Value }));
  const secret = (Name, ValueFrom) => ({ Name, ValueFrom });
  const token = secret('PEROTTINO_BEDROCK_WORKER_TOKEN', config.workerSecretArn);
  const health = script => ({ Command: ['CMD', 'node', '-e', script], Interval: 15, Retries: 3, Timeout: 5, StartPeriod: 30 });
  const ipc = '/run/perottino-worker';
  const socket = ipc + '/decision.sock';
  const mount = (SourceVolume, ContainerPath, ReadOnly) => ({ SourceVolume, ContainerPath, ReadOnly });
  const volume = (Name, SourcePath) => ({ Name, Host: { SourcePath } });
  function task(id, suffix, executionRole, runtimeRole, volumes, containers, networkMode = 'bridge') {
    return resource(id, 'ECS::TaskDefinition', { Family: prefix + suffix, NetworkMode: networkMode,
      RequiresCompatibilities: ['EC2'], ExecutionRoleArn: attr(executionRole, 'Arn'),
      ...(runtimeRole && { TaskRoleArn: attr(runtimeRole, 'Arn') }), Volumes: volumes, ContainerDefinitions: containers,
    });
  }
  const renderIpc = '/run/perottino-render';
  const renderSocket = renderIpc + '/renderer.sock';
  const readOnlyLinux = { InitProcessEnabled: true, Capabilities: { Drop: ['ALL'] },
    Tmpfs: [{ ContainerPath: '/tmp', Size: 256, MountOptions: ['rw', 'nosuid', 'nodev'] }] };
  const socketHealth = variable => health("const s=require('node:net').connect(process.env." + variable
    + ");s.on('connect',()=>s.end());s.on('error',()=>process.exit(1))");
  const renderer = task('RendererTask', 'renderer', renderExec, null, [volume('render', renderIpc)], [{
    Name: 'renderer', Essential: true, Image: config.appImage, User: '1000:1000', Memory: 640, Cpu: 512,
    Command: ['node', 'src/renderer.mjs'], Environment: env({ NODE_ENV: 'production', PEROTTINO_BROWSER_EXTERNAL_SANDBOX: '1',
      PEROTTINO_BROWSER_RENDER_SOCKET: renderSocket }), MountPoints: [mount('render', renderIpc, false)],
    ReadonlyRootFilesystem: true, DockerSecurityOptions: ['no-new-privileges'], LinuxParameters: readOnlyLinux,
    HealthCheck: socketHealth('PEROTTINO_BROWSER_RENDER_SOCKET'), LogConfiguration: log('renderer'),
  }], 'none');
  const worker = task('WorkerTask', 'worker', workerExec, workerRole, [volume('ipc', ipc)], [{
    Name: 'model', Essential: true, Image: config.appImage, User: '1000:1000', Memory: 1280, Cpu: 1024,
    Command: ['node', 'src/agent.mjs', '--bedrock-worker'], LogConfiguration: log('worker'),
    HealthCheck: socketHealth('PEROTTINO_BEDROCK_WORKER_SOCKET'),
    Environment: env({ NODE_ENV: 'production', AWS_REGION: region, PEROTTINO_BEDROCK_MODEL: config.bedrockModel,
      PEROTTINO_BEDROCK_WORKER_SOCKET: socket }), Secrets: [token], MountPoints: [mount('ipc', ipc, false)],
    ReadonlyRootFilesystem: true, LinuxParameters: readOnlyLinux,
  }]);
  const consoleTask = task('ConsoleTask', 'console', webExec, webRole,
    [volume('company', '/var/lib/perottino-host/company'), volume('tls', '/var/lib/perottino-host/proxy'), volume('ipc', ipc), volume('render', renderIpc)], [
      { Name: 'console', Image: config.appImage, User: '1000:1000', Memory: 896, Cpu: 384, Essential: true,
        Environment: env({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', DATA_DIR: '/var/lib/perottino',
          PUBLIC_ORIGIN: 'https://' + config.hostname, PEROTTINO_AGENT_MODE: 'bedrock',
          PEROTTINO_BROWSER_RENDER_SOCKET: renderSocket, PEROTTINO_BEDROCK_WORKER_SOCKET: socket }),
        Secrets: [secret('OWNER_USERNAME', config.ownerSecretArn + ':username::'), secret('OWNER_PASSWORD_HASH',
          config.ownerSecretArn + ':passwordHash::'), token], MountPoints: [mount('company', '/var/lib/perottino', false), mount('ipc', ipc, true), mount('render', renderIpc, true)],
        HealthCheck: health("fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"),
        ReadonlyRootFilesystem: true, DockerSecurityOptions: ['no-new-privileges'],
        LogConfiguration: log('console'), LinuxParameters: readOnlyLinux,
      },
      { Name: 'edge', Image: config.proxyImage, Essential: true, Memory: 128, Cpu: 64, Links: ['console'],
        EntryPoint: ['caddy'], Command: ['reverse-proxy', '--from', config.hostname, '--to', 'http://console:3000'],
        PortMappings: [80, 443].map(port => ({ HostPort: port, ContainerPort: port, Protocol: 'tcp' })),
        MountPoints: [mount('tls', '/data', false)], LogConfiguration: log('edge'),
      },
    ]);
  function service(id, name, definition) {
    const svc = resource(id, 'ECS::Service', { ServiceName: prefix + name, Cluster: cluster.ref, DesiredCount: config.hostState === 'quiesced' ? 0 : 1,
      LaunchType: 'EC2', PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:company-volume == ' + data.ref }],
      TaskDefinition: definition.ref, DeploymentConfiguration: { MaximumPercent: 100, MinimumHealthyPercent: 0,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true } }, EnableECSManagedTags: true, PropagateTags: 'TASK_DEFINITION',
    });
    svc.addDependency(attachment);
    svc.addDependency(association);
    return svc;
  }
  if (!detached) {
    const workerService = service('WorkerService', 'model', worker);
    const rendererService = service('RendererService', 'render', renderer);
    const consoleService = service('ConsoleService', 'chat', consoleTask);
    consoleService.addDependency(workerService);
    consoleService.addDependency(rendererService);
  }
  for (const [id, value] of Object.entries({ Url: 'https://' + config.hostname + '/chat', PublicIp: address.ref,
    VolumeId: data.ref, ...(host && { InstanceId: host.ref }), ClusterName: cluster.ref })) new CfnOutput(stack, id, { value });
  return app.synth().getStackArtifact(stack.artifactId);
}
