import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { getProjectsReviewerCredential } from '../src/project-reviewer-credential.mjs';

test('an unenrolled reviewer uses the shared identity while invalid configured secrets fail explicitly', async () => {
  const get = value => getProjectsReviewerCredential({ secretArn:'slot', readSecret:async () => value });
  assert.equal(await getProjectsReviewerCredential({readSecret:assert.fail}), null);
  assert.equal(await get(null), null);
  assert.equal(await get('github_pat_example'), 'github_pat_example');
  for (const value of ['', 'github_pat_bad\n', '{"token":"unrecognized"}', undefined]) {
    await assert.rejects(get(value), {status:503, message:'Could not use the configured projects reviewer credential.'});
  }
  await assert.rejects(getProjectsReviewerCredential({secretArn:'slot',readSecret:async()=>{throw Error('sensitive fixture');}}),
    {status:503, message:'Could not use the configured projects reviewer credential.'});
});

test('App review auth signs a short JWT and requests write access only to pull requests in the configured repo', async () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:2048});
  const pem = privateKey.export({type:'pkcs8',format:'pem'});
  let installOwner = 'The-CarL';
  const calls = [];
  async function fetchImpl(url,options) {
    const {origin,pathname} = new URL(url);
    assert.equal(origin,'https://api.github.com');
    assert.equal(options.redirect,'error');
    calls.push(pathname);
    const token = options.headers.Authorization.slice('Bearer '.length);
    if (pathname === '/users/perottino-test%5Bbot%5D') {
      assert.equal(token,'install-token');
      return Response.json({login:'perottino-test[bot]',type:'Bot',id:42});
    }
    const [header,payload,signature] = token.split('.');
    assert.equal(verify('RSA-SHA256',Buffer.from(header+'.'+payload),publicKey,Buffer.from(signature,'base64url')),true);
    assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iat:940,exp:1540,iss:'12'});
    if (pathname === '/app') return Response.json({slug:'perottino-test',id:12});
    if (pathname === '/app/installations/34') return Response.json({app_id:12,id:34,account:{login:installOwner}});
    assert.equal(pathname,'/app/installations/34/access_tokens');
    assert.deepEqual(JSON.parse(options.body),{repositories:['perottino-co-projects'],permissions:{pull_requests:'write'}});
    return Response.json({token:'install-token',permissions:{pull_requests:'write'},repositories:[{full_name:'The-CarL/perottino-co-projects'}]});
  }
  const get = () => getProjectsReviewerCredential({secretArn:'slot',repository:'The-CarL/perottino-co-projects',
    now:()=>1000000,readSecret:async()=>JSON.stringify({appId:12,installationId:'34',privateKey:pem}),fetchImpl});
  assert.deepEqual(await get(),{token:'install-token',actorId:42});
  assert.equal(calls.length,4);
  calls.length=0;
  installOwner='another-account';
  await assert.rejects(get(),{status:503});
  assert.ok(!calls.includes('/app/installations/34/access_tokens'));
});
