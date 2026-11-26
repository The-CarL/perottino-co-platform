import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synthHosted } from '../infra/hosted.mjs';

const fixture = file => JSON.parse(readFileSync(new URL('../infra/' + file, import.meta.url), 'utf8'));
const sample = () => fixture('example-hosted.json');
function render(t, config = sample()) {
  const dir = mkdtempSync(join(tmpdir(), 'company-hosted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return synthHosted(config, fixture('example-provenance.json'), dir);
}
function script(template) {
  return template.Resources.Host.Properties.UserData['Fn::Base64']['Fn::Join'][1]
    .map(part => typeof part === 'string' ? part : ({ Cluster: 'test-cluster', Data: 'vol-12345678' })[part.Ref]).join('');
}
function parseShell(content) {
  const result = spawnSync('bash', ['-n', '-c', content], { timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('private inputs target two distinct accounts, regions, domains, images and secrets', t => {
  const config = JSON.parse(JSON.stringify(sample()).replaceAll('111111111111', '222222222222')
    .replaceAll('us-east-1', 'us-east-2').replaceAll('company.example.com', 'chat.example.net'));
  delete config.hostedZoneId;
  const assembly = render(t, config);
  assert.equal(assembly.environment.name, 'aws://222222222222/us-east-2');
  assert.ok(assembly.manifest.properties.terminationProtection);
  assert.deepEqual(assembly.template, render(t, config).template);
  const raw = JSON.stringify(assembly.template);
  assert.doesNotMatch(raw, /111111111111:|111111111111\.dkr|us-east-1|company\.example\.com|carloperottino\.com/);
  assert.ok(raw.includes(config.workerSecretArn) && raw.includes(config.proxyImage));
  assert.equal(assembly.template.Resources.Dns, undefined);
  assert.equal(assembly.template.Outputs.Url.Value, 'https://chat.example.net/chat');
});

test('a target-account release pins artifacts and rejects cross-account credentials, wildcards and mutable tags', t => {
  for (const change of [
    c => { c.appImage = c.appImage.replace('@sha256:', ':'); },
    c => { c.proxyImage = c.proxyImage.replace('example-company', 'other'); },
    c => { c.proxyImage = c.proxyImage.replace('111111111111', '222222222222'); },
    c => { c.ownerSecretArn = c.ownerSecretArn.replace('us-east-1', 'eu-west-1'); },
    c => { c.workerSecretArn = c.ownerSecretArn; },
    c => { c.workerSecretArn = c.workerSecretArn.replace('example/worker', '/perottino-co/github/pat'); },
    c => { c.ownerSecretArn = c.ownerSecretArn.replace('example/owner', '/perottino-co/github/pat'); },
    c => { c.bedrockResourceArns.push('*'); },
    c => { c.availabilityZone = 'us-west-2b'; },
    c => { c.permissionsBoundaryArn += '*'; },
  ]) {
    const config = sample();
    change(config);
    assert.throws(() => render(t, config), /Invalid hosted configuration/);
  }
});

test('tasks isolate the renderer, worker and verified owner endpoint on an approved host', t => {
  const { Resources: r } = render(t).template;
  const consoleTask = r.ConsoleTask.Properties;
  const [web, edge] = consoleTask.ContainerDefinitions;
  assert.deepEqual(edge.PortMappings.map(p => p.HostPort), [80, 443]);
  assert.equal(web.PortMappings, undefined);
  assert.deepEqual(edge.Links, ['console']);
  assert.equal(edge.Secrets, undefined);
  assert.deepEqual(r.SecurityGroup.Properties.SecurityGroupIngress.map(rule => rule.FromPort), [80, 443]);
  assert.deepEqual(consoleTask.ExecutionRoleArn, { 'Fn::GetAtt': ['WebExecution', 'Arn'] });
  assert.ok(web.MountPoints.find(m => m.SourceVolume === 'company' && !m.ReadOnly));
  const worker = r.WorkerTask.Properties;
  const [model] = worker.ContainerDefinitions;
  assert.deepEqual(worker.TaskRoleArn, { 'Fn::GetAtt': ['WorkerRole', 'Arn'] });
  assert.deepEqual(worker.Volumes.map(v => v.Name), ['ipc']);
  assert.deepEqual(model.Secrets.map(s => s.Name), ['PEROTTINO_BEDROCK_WORKER_TOKEN']);
  const workerGrants = r.WorkerRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(workerGrants[0].Resource, sample().bedrockResourceArns);
  const renderer = r.RendererTask.Properties;
  const [browser] = renderer.ContainerDefinitions;
  assert.equal(renderer.NetworkMode, 'none');
  assert.equal(renderer.TaskRoleArn, undefined);
  assert.equal(browser.Secrets, undefined);
  assert.equal(browser.PortMappings, undefined);
  assert.deepEqual(renderer.Volumes.map(v => v.Name), ['render']);
  assert.deepEqual(browser.DockerSecurityOptions, ['no-new-privileges']);
  assert.deepEqual(browser.LinuxParameters.Capabilities.Drop, ['ALL']);
  assert.ok(browser.ReadonlyRootFilesystem);
  assert.ok(browser.Environment.some(e => e.Name === 'PEROTTINO_BROWSER_EXTERNAL_SANDBOX' && e.Value === '1'));
  assert.ok(!web.Environment.some(e => e.Name === 'PEROTTINO_BROWSER_EXTERNAL_SANDBOX'));
  for (const id of ['RenderExecution', 'HostRole', 'WorkerRole', 'WebRole']) {
    assert.ok(!JSON.stringify(r[id]).includes('secretsmanager:GetSecretValue'));
  }
  for (const role of Object.values(r).filter(x => x.Type === 'AWS::IAM::Role')) {
    assert.equal(role.Properties.PermissionsBoundary, sample().permissionsBoundaryArn);
    assert.match(role.Properties.Path, /^\/factory\/.+\/$/);
  }
  for (const [id, count] of [['WebExecution', 2], ['WorkerExecution', 1], ['RenderExecution', 0], ['HostRole', 0]]) {
    const policies = r[id].Properties.Policies[0].PolicyDocument.Statement;
    const secrets = policies.filter(s => s.Action === 'secretsmanager:GetSecretValue');
    assert.equal(secrets.length, count);
    for (const grant of secrets) {
      const tags = grant.Condition.StringEquals;
      assert.equal(tags['aws:ResourceTag/factory:s'], '11111111-1111-4111-8111-111111111111-example');
      assert.equal(tags['aws:ResourceTag/perottino:purpose'], grant.Resource === sample().ownerSecretArn ? 'owner-verifier' : 'worker-token');
    }
    const imagePull = policies.find(s => Array.isArray(s.Action) && s.Action.includes('ecr:BatchGetImage'));
    assert.equal(imagePull.Condition.StringEquals['aws:ResourceTag/perottino:purpose'], 'runtime-images');
  }
  const universal = r.HostRole.Properties.Policies[0].PolicyDocument.Statement.filter(s => s.Resource === '*');
  assert.deepEqual(universal.map(s => s.Action).sort(), ['ecr:GetAuthorizationToken', 'ecs:DiscoverPollEndpoint']);
  const containers = [web, edge, model, browser];
  assert.ok(containers.reduce((sum, c) => sum + c.Memory, 0) + 384 < 3600);
  for (const s of [r.ConsoleService, r.RendererService, r.WorkerService]) {
    assert.equal(s.Properties.DesiredCount, 1);
    assert.equal(s.Properties.DeploymentConfiguration.MaximumPercent, 100);
    assert.ok(s.DependsOn.includes('Mount') && s.DependsOn.includes('IpBinding'));
    assert.ok(JSON.stringify(s.Properties.PlacementConstraints).includes('company-volume'));
  }
});

test('encrypted ext4 storage gates ECS on each boot and supports quiesce, detached maintenance and restore', t => {
  const template = render(t).template;
  const { Host, Data, Address } = template.Resources;
  assert.ok(Data.Properties.Encrypted);
  assert.equal(Data.DeletionPolicy, 'Retain');
  assert.equal(Data.UpdateReplacePolicy, 'Retain');
  assert.equal(Address.DeletionPolicy, 'Retain');
  assert.equal(Host.Properties.MetadataOptions.HttpTokens, 'required');
  assert.equal(Host.Properties.MetadataOptions.HttpPutResponseHopLimit, 1);
  const init = script(template);
  assert.doesNotMatch(init, /@@|undefined/);
  parseShell(init);
  parseShell(init.split("<<'STORAGE'\n")[1].split('\nSTORAGE\n')[0]);
  for (const step of ['vol-12345678', 'cmp --silent', 'Requires=perottino-storage.service',
    'mountpoint -q', 'findmnt -n -o MAJ:MIN', '169.254.169.254', 'ECS_INSTANCE_ATTRIBUTES']) assert.ok(init.includes(step));
  const quiet = render(t, { ...sample(), hostState: 'quiesced' }).template.Resources;
  const offline = render(t, { ...sample(), hostState: 'detached' }).template.Resources;
  assert.equal(quiet.ConsoleService.Properties.DesiredCount, 0);
  assert.equal(quiet.RendererService.Properties.DesiredCount, 0);
  assert.equal(quiet.WorkerService.Properties.DesiredCount, 0);
  for (const id of ['Host', 'Mount', 'IpBinding', 'ConsoleService', 'WorkerService', 'RendererService']) assert.equal(offline[id], undefined);
  assert.deepEqual(offline.Data, Data);
  assert.deepEqual(offline.Address, Address);
  const restored = render(t, { ...sample(), dataSnapshotId: 'snap-12345678' }).template;
  assert.equal(restored.Resources.Data.Properties.SnapshotId, 'snap-12345678');
  assert.match(script(restored), /\[ 'no' = yes \]/);
});
