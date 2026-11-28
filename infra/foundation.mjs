import {
  App, LegacyStackSynthesizer, CfnOutput, CfnResource, Duration, RemovalPolicy, Stack, Tags,
  aws_dynamodb as dynamodb, aws_s3 as s3, aws_sqs as sqs,
} from 'aws-cdk-lib';

const resourceIds = ['Foundation', 'State', 'Files', 'Wake', 'DeadLetters'];
const requiredTags = [
  'managed-by', 'project-id', 'environment', 'owner', 'source-repo', 'source-commit',
  'created-by', 'created-at', 'creation-run-id', 'last-run-id', 'last-source-commit',
  'provenance-version', 'expires-at', 'project-name', 'repo-name', 'source-branch',
  'source-author', 'last-source-branch', 'last-source-author',
].map(key => 'factory:' + key);
const changeTags = ['last-run-id', 'last-source-commit', 'last-source-branch', 'last-source-author']
  .map(key => 'factory:' + key);

export function resourceTags({ tags, overrides = {} }, ids = resourceIds) {
  if (!tags || Object.keys(tags).length !== requiredTags.length
      || Object.keys(overrides).some(id => !ids.includes(id))) {
    throw new Error('Use the complete factory tags and recognized resource IDs');
  }
  const project = tags['factory:project-id'];
  const environment = tags['factory:environment'];
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(project)
      || project === '00000000-0000-0000-0000-000000000000'
      || typeof environment !== 'string' || !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(environment)
      || environment.includes('--') || environment.split('-').includes('r')) {
    throw new Error('Invalid factory project UUID or environment');
  }
  const scope = project + '-' + environment;
  const repo = tags['factory:source-repo'];
  if (tags['factory:managed-by'] !== 'engineering-factory' || tags['factory:provenance-version'] !== '1'
      || !/^[\w.-]+\/[\w.-]+$/.test(repo) || tags['factory:repo-name'] !== repo.split('/')[1]) {
    throw new Error('Invalid factory manager, provenance version or source repository');
  }
  function timestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
      && Number.isFinite(Date.parse(value));
  }
  if (!timestamp(tags['factory:created-at'])
      || (tags['factory:expires-at'] !== 'none' && !timestamp(tags['factory:expires-at']))) {
    throw new Error('Use UTC RFC 3339 creation and expiry times, or none for approved retention');
  }
  return Object.fromEntries(ids.map(id => {
    const changes = overrides[id] ?? {};
    if (Object.keys(changes).some(key => !changeTags.includes(key))) {
      throw new Error('Resource overrides may update only latest change attribution');
    }
    const values = { ...tags, ...changes, 'factory:s': scope };
    for (const key of requiredTags) {
      const value = values[key];
      if (typeof value !== 'string' || !/^[\p{L}\p{N} ._:/=+@-]{1,256}$/u.test(value)
          || value.trim() !== value || value.includes('://') || /\S+@\S+\.\S+/.test(value)) {
        throw new Error('Invalid or missing nonsecret tag ' + key);
      }
    }
    for (const key of ['factory:source-commit', 'factory:last-source-commit']) {
      if (!/^[0-9a-f]{40}$/.test(values[key])) throw new Error('Use a full Git SHA for ' + key);
    }
    return [id, values];
  }));
}

export function synthFoundation(provenance, outdir) {
  const tags = resourceTags(provenance);
  const app = new App({ outdir, autoSynth: false, analyticsReporting: false, treeMetadata: false });
  const name = 'factory-' + tags.Foundation['factory:s'] + '-r-foundation';
  // This asset-free template uses the caller’s approved CloudFormation identity.
  const stack = new Stack(app, 'Foundation', {
    stackName: name, terminationProtection: true, synthesizer: new LegacyStackSynthesizer(),
    description: 'Perottino and Co durable company records, corporate files, and wake notifications',
  });
  for (const [key, value] of Object.entries(tags.Foundation)) stack.tags.setTag(key, value);

  const table = new dynamodb.Table(stack, 'State', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, deletionProtection: true,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });
  const files = new s3.Bucket(stack, 'Files', {
    versioned: true, encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  });
  const queueOptions = { encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true };
  const deadLetters = new sqs.Queue(stack, 'DeadLetters', {
    ...queueOptions, retentionPeriod: Duration.days(14),
  });
  const wake = new sqs.Queue(stack, 'Wake', {
    ...queueOptions, retentionPeriod: Duration.days(4), visibilityTimeout: Duration.minutes(5),
    deadLetterQueue: { queue: deadLetters, maxReceiveCount: 5 },
  });

  for (const resource of [table, files, wake, deadLetters]) {
    for (const [key, value] of Object.entries(tags[resource.node.id])) Tags.of(resource).add(key, value);
  }
  for (const child of stack.node.findAll()) {
    if (child instanceof CfnResource) child.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }

  new CfnOutput(stack, 'StateTableName', { value: table.tableName });
  new CfnOutput(stack, 'CorporateBucketName', { value: files.bucketName });
  new CfnOutput(stack, 'WakeQueueUrl', { value: wake.queueUrl });
  new CfnOutput(stack, 'DeadLetterQueueUrl', { value: deadLetters.queueUrl });
  return app.synth().getStackArtifact(stack.artifactId);
}
