import { createPrivateKey, sign } from 'node:crypto';
import { fault, insist, projectsRepository } from './project-source.mjs';

// All requests go to the GitHub API. Neither credentials nor provider response bodies reach the employee broker.
async function github(path, token, body, fetchImpl) {
  const response = await fetchImpl('https://api.github.com' + path, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'perottino-projects',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  insist(response.ok, 503, 'GitHub reviewer identity could not be authenticated.');
  return response.json();
}

async function readReviewerSecret(arn) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  try {
    return (await client.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }))).SecretString;
  } catch (error) {
    // An IaC-created slot exists before its owner writes its first secret version.
    if (error.name === 'ResourceNotFoundException' && /AWSCURRENT/i.test(error.message)) return null;
    throw error;
  } finally { client.destroy(); }
}

function numericId(value) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,19}$/.test(String(value));
}

export async function getProjectsReviewerCredential({
  secretArn, repository, readSecret = readReviewerSecret, fetchImpl = fetch, now = Date.now,
}) {
  if (!secretArn) return null;
  try {
    const value = await readSecret(secretArn);
    if (value === null) return null;
    insist(typeof value === 'string' && value.length > 0 && value.length <= 32_768, 503, 'Invalid reviewer secret.');
    if (!value.trimStart().startsWith('{')) {
      insist(value.startsWith('github_pat_') && !/\s/.test(value) && value.length <= 4096, 503, 'Invalid reviewer PAT.');
      return value;
    }
    const { appId, installationId, privateKey } = JSON.parse(value);
    const [owner, name] = projectsRepository(repository).split('/');
    insist(numericId(appId) && numericId(installationId) && typeof privateKey === 'string', 503, 'Invalid reviewer App settings.');
    const key = createPrivateKey(privateKey);
    insist(key.asymmetricKeyType === 'rsa', 503, 'Invalid reviewer App key.');
    const seconds = Math.floor(now() / 1000);
    const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
    const data = encode({ alg:'RS256', typ:'JWT' }) + '.' + encode({ iat:seconds-60, exp:seconds+540, iss:String(appId) });
    const jwt = data + '.' + sign('RSA-SHA256', Buffer.from(data), key).toString('base64url');
    const [app, installation] = await Promise.all([
      github('/app', jwt, null, fetchImpl),
      github('/app/installations/'+installationId, jwt, null, fetchImpl),
    ]);
    insist(String(app.id) === String(appId) && typeof app.slug === 'string' && /^[a-z0-9-]+$/i.test(app.slug) &&
      String(installation.id) === String(installationId) && String(installation.app_id) === String(appId) &&
      installation.account?.login?.toLowerCase() === owner.toLowerCase(), 503, 'Unexpected reviewer App or installation.');
    const issued = await github('/app/installations/'+installationId+'/access_tokens', jwt, {
      repositories:[name], permissions:{ pull_requests:'write' },
    }, fetchImpl);
    insist(typeof issued.token === 'string' && issued.token.length > 0 && !/\s/.test(issued.token) &&
      issued.permissions?.pull_requests === 'write', 503, 'Invalid installation credential.');
    if (issued.repositories) {
      insist(Array.isArray(issued.repositories) && issued.repositories.length === 1 &&
        issued.repositories[0].full_name?.toLowerCase() === (owner+'/'+name).toLowerCase(), 503, 'Unexpected reviewer repo.');
    }
    const login = app.slug + '[bot]';
    const bot = await github('/users/'+encodeURIComponent(login), issued.token, null, fetchImpl);
    insist(bot.type === 'Bot' && Number.isSafeInteger(bot.id) && bot.id > 0 && bot.login?.toLowerCase() === login.toLowerCase(),
      503, 'Unexpected reviewer App identity.');
    return { token:issued.token, actorId:bot.id };
  } catch {
    throw fault(503, 'Could not use the configured projects reviewer credential.');
  }
}
