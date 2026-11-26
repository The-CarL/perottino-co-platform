import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/publish-images.sh', import.meta.url));
const account = '123456789012';
const uri = account + '.dkr.ecr.us-east-1.amazonaws.com/fixture';
const image = data => uri + '@sha256:' + createHash('sha256').update(data).digest('hex');

// These two executables implement only the AWS and Docker calls used by the publisher.
// Each successful build stores its content digest in the fake registry for later lookups.
const fakeAws = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const param = key => a[a.indexOf(key) + 1];
const op = a.slice(0,2).join(' ');
const state = process.env.FIXTURE;
fs.appendFileSync(state + '/calls', op + '\\n');
if (param('--region') !== 'us-east-1') process.exit(90);
if (op === 'sts get-caller-identity') console.log(process.env.IDENTITY);
else if (op === 'cloudformation describe-stacks') {
  if (param('--stack-name') !== 'fixture-stack') process.exit(90);
  console.log(param('--query').includes('ImageRepositoryName') ? 'fixture' : process.env.REGISTRY_URI);
} else if (op === 'ecr get-login-password') console.log('fixture-login');
else if (op === 'ecr describe-images') {
  if (param('--repository-name') !== 'fixture') process.exit(90);
  const tag = param('--image-ids').replace(/^imageTag=/, '');
  const file = state + '/' + tag;
  if (!fs.existsSync(file)) {
    console.error('An error occurred (ImageNotFoundException) when calling DescribeImages.');
    process.exit(254);
  }
  console.log(fs.readFileSync(file, 'utf8'));
} else process.exit(90);
`;

const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');
const a = process.argv.slice(2);
const state = process.env.FIXTURE;
const uri = process.env.REGISTRY_URI;
if (a[0] === 'login') {
  if (!a.includes('--password-stdin') || a.at(-1) !== uri.split('/')[0] ||
      fs.readFileSync(0,'utf8').trim() !== 'fixture-login') process.exit(90);
  fs.appendFileSync(state + '/calls', 'docker login\\n');
} else if (a[0] === 'buildx' && a[1] === 'build') {
  const context = a.at(-1);
  const dockerfile = a[a.indexOf('--file') + 1];
  const tag = a[a.indexOf('--tag') + 1];
  if (!a.includes('--push') || a[a.indexOf('--platform') + 1] !== 'linux/amd64' ||
      !tag.startsWith(uri + ':') || !dockerfile.startsWith(context + '/') ||
      fs.existsSync(path.join(context, 'untracked-secret'))) process.exit(90);
  const key = tag.slice(uri.length + 1);
  fs.appendFileSync(state + '/calls', 'build ' + key + '\\n');
  const proxy = key.startsWith('proxy-');
  if (proxy && process.env.FAIL_PROXY) process.exit(72);
  const manifest = fs.readFileSync(dockerfile, 'utf8') +
    (proxy ? '' : fs.readFileSync(path.join(context, 'payload.txt'), 'utf8'));
  const digest = 'sha256:' + createHash('sha256').update(manifest).digest('hex');
  fs.writeFileSync(path.join(state, key), digest, {flag:'wx'});
} else process.exit(90);
`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'perottino-image-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'worktree');
  const bin = join(base, 'bin');
  const state = join(base, 'registry');
  await Promise.all([mkdir(join(repo, 'infra'), { recursive: true }), mkdir(bin), mkdir(state)]);
  const env = { PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: base,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', IDENTITY: account, TARGET_ACCOUNT: account,
    AWS_REGION: 'us-east-1', BOOTSTRAP_STACK: 'fixture-stack', REGISTRY_URI: uri, FIXTURE: state };
  const git = async (...args) => (await run('git', args, { cwd: repo, env })).stdout.trim();
  const appSource = 'FROM scratch\n';
  const proxySource = 'FROM scratch AS proxy\n';
  const payload = 'committed platform content\n';
  await Promise.all([
    writeFile(join(bin, 'aws'), fakeAws, { mode: 0o700 }),
    writeFile(join(bin, 'docker'), fakeDocker, { mode: 0o700 }),
    writeFile(join(repo, 'Dockerfile'), appSource),
    writeFile(join(repo, 'infra/Proxy.Dockerfile'), proxySource),
    writeFile(join(repo, 'payload.txt'), payload),
  ]);
  await git('init', '--quiet');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const appTag = 'platform-' + await git('rev-parse', 'HEAD');
  const proxyTag = 'proxy-' + await git('rev-parse', 'HEAD:infra/Proxy.Dockerfile');
  await Promise.all([
    writeFile(join(repo, 'payload.txt'), 'dirty application files'),
    writeFile(join(repo, 'infra/Proxy.Dockerfile'), 'dirty proxy instructions'),
    writeFile(join(repo, 'untracked-secret'), 'synthetic material to exclude'),
  ]);
  return { appTag, proxyTag, state, expected: { appImage: image(appSource + payload), proxyImage: image(proxySource) },
    publish: (overrides = {}) => run('bash', [script], { cwd: repo, env: { ...env, ...overrides } }),
    calls: async () => (await readFile(join(state, 'calls'), 'utf8')).trim().split('\n') };
}

test('publisher stops before lookup or login when the selected account differs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.publish({ IDENTITY: '999999999999' }), error =>
    error.code === 2 && /identity does not match/.test(error.stderr));
  assert.deepEqual(await f.calls(), ['sts get-caller-identity']);
});

test('publisher builds committed files, emits registry digests, and resumes a partial publication', async t => {
  const f = await fixture(t);
  await assert.rejects(f.publish({ FAIL_PROXY: '1' }), error => error.code !== 0 && error.stdout === '');
  assert.equal(await readFile(join(f.state, f.appTag), 'utf8'), f.expected.appImage.split('@')[1]);
  const recovered = await f.publish();
  assert.deepEqual(JSON.parse(recovered.stdout), f.expected);
  const repeated = await f.publish();
  assert.deepEqual(JSON.parse(repeated.stdout), f.expected);
  assert.deepEqual((await f.calls()).filter(op => op.startsWith('build ')), [
    'build ' + f.appTag, 'build ' + f.proxyTag, 'build ' + f.proxyTag,
  ]);
});

test('publisher rejects an invalid existing registry digest', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, f.appTag), 'sha256:invalid');
  await assert.rejects(f.publish(), error =>
    error.code !== 0 && !error.stdout && /invalid manifest digest/.test(error.stderr));
  assert.ok(!(await f.calls()).some(op => op.startsWith('build ')));
});
