import { author, branchFor, commitMessage, fault, insist, jobSpec, mergeAttribution, mergeSpec, mergeTrailers, pathFor, projectsRepository, reviewSpec, shaFormat } from './project-source.mjs';
import { getProjectsReviewerCredential } from './project-reviewer-credential.mjs';

export function createGitHubProjects({ repository: configured, getToken, getReviewerToken, fetchImpl=fetch }) {
  const repository=projectsRepository(configured);
  const apiRoot='https://api.github.com/repos/'+repository;
  const owner=repository.split('/')[0];
  async function session(credential) {
    const token=credential ?? await getToken();
    insist(typeof token==='string' && token.length>0 && token.length<=4096 && !/[\r\n]/.test(token),503,'Projects Git credential unavailable.');
    return async function request(path,{method='GET',body,allow=[]}={}) {
      const url = ['/user','/graphql'].includes(path) ? 'https://api.github.com'+path : apiRoot+path;
      const result=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(12_000),
        headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'perottino-projects',
          Authorization:'Bearer '+token,...(body && {'Content-Type':'application/json'})},...(body && {body:JSON.stringify(body)})});
      if (allow.includes(result.status)) { await result.body?.cancel(); return null; }
      if (!result.ok) { await result.body?.cancel(); throw fault(503,'Projects Git request failed (HTTP '+result.status+').'); }
      const parts=[];let size=0;
      for await (const part of result.body) {
        size+=part.length;
        insist(size<=3_000_000,502,'Projects Git response exceeded its limit.');
        parts.push(part);
      }
      try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { throw fault(502,'Invalid projects Git response.'); }
    };
  }
  async function repoInfo(api) {
    const info=await api('');
    insist(info.full_name?.toLowerCase()===repository.toLowerCase() && typeof info.private==='boolean' && !info.archived,403,'Expected the configured writable projects repository.');
    insist(typeof info.default_branch==='string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,160}$/.test(info.default_branch)
      && !info.default_branch.includes('..'),502,'Invalid default branch.');
    return info;
  }
  const ref=branch=>'/git/ref/heads/'+branch.split('/').map(encodeURIComponent).join('/');
  function treeSha(obj) { insist(shaFormat.test(obj?.sha),502,'Invalid Git object identity.');return obj.sha; }
  async function checkDirectory(api,tree,name) {
    const folder=await api('/git/trees/'+tree);
    insist(!folder.truncated && Array.isArray(folder.tree),502,'Git tree is too large to inspect.');
    const entry=folder.tree.find(x=>x.path===name);
    if (!entry) return null;
    insist(entry.type==='tree' && entry.mode==='040000',409,'Project destination is not a directory.');
    return treeSha(entry);
  }
  async function openSession(input,credential) {
    const handoff = mergeSpec(input,repository);
    const api = await session(credential);
    const info = await repoInfo(api);
    const path = '/pulls/' + handoff.pr.number;
    async function readPull() {
      const pr = await api(path,{allow:[404]});
      insist(pr?.number === handoff.pr.number && pr.base?.ref === info.default_branch &&
        pr.head?.ref === handoff.branch && pr.head.sha === handoff.sha &&
        pr.head.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
        pr.base.repo?.full_name?.toLowerCase() === repository.toLowerCase(),
      409,'The pull request target or head has changed since review.');
      return pr;
    }
    return {handoff,api,info,path,readPull};
  }
  async function publishReview(input,decision) {
    const {reviewerId,reviewId,decision:outcome} = reviewSpec(decision);
    // The trusted credential helper verifies the installation bot identity. PAT identity is verified below.
    const reviewer = await getReviewerToken?.();
    const installation = reviewer != null && typeof reviewer === 'object';
    if (installation) insist(typeof reviewer.token === 'string' && Number.isSafeInteger(reviewer.actorId) &&
      reviewer.actorId > 0,503,'Could not verify the GitHub App reviewer.');
    const {handoff,api,path,readPull} = await openSession(input,installation ? reviewer.token : reviewer);
    async function readOpenPull() {
      const pull = await readPull();
      insist(pull.state === 'open' && !pull.merged,409,'The reviewed pull request is closed.');
      return pull;
    }
    const pull = await readOpenPull();
    const actorId = installation ? reviewer.actorId : (await api('/user')).id;
    insist(Number.isSafeInteger(actorId) && actorId > 0 && Number.isSafeInteger(pull.user?.id) &&
      pull.user.id > 0,503,'Could not verify the GitHub review identity.');
    const native = reviewer != null;
    if (native) insist(actorId !== pull.user.id,409,'Configure a GitHub reviewer distinct from the pull request author.');
    const event = native ? (outcome === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES') : 'COMMENT';
    const state = {APPROVE:'APPROVED',REQUEST_CHANGES:'CHANGES_REQUESTED',COMMENT:'COMMENTED'}[event];
    const text = 'Project peer review by `' + reviewerId + '` for `' + handoff.sha + '`: ' +
      (outcome === 'approve' ? 'approved.' : 'changes requested.') + '\n\n<!-- perottino-peer-review:' + reviewId + ' -->';
    const reviews = path + '/reviews';
    function receipt(row) {
      if (row?.body !== text || row.commit_id !== handoff.sha || row.user?.id !== actorId) return null;
      insist(row.state !== 'DISMISSED',409,'GitHub dismissed this peer review. A new review decision is required.');
      insist(row.state === state && Number.isSafeInteger(row.id) && row.id > 0,503,'GitHub returned an unexpected review receipt.');
      const url = 'https://github.com/' + repository + '/pull/' + handoff.pr.number + '#pullrequestreview-' + row.id;
      insist(typeof row.html_url === 'string' && row.html_url.toLowerCase() === url.toLowerCase(),
        503,'GitHub returned an unexpected review URL.');
      return {id:row.id,url,sha:handoff.sha,prNumber:handoff.pr.number,state};
    }
    // GitHub has no create-review idempotency key. Search prior pages before ever repeating a POST.
    for (let page = 1; page <= 5; page++) {
      const rows = await api(reviews + '?per_page=100&page=' + page);
      insist(Array.isArray(rows),502,'Invalid GitHub review list.');
      for (const row of rows) {
        const existing = receipt(row);
        if (existing) return existing;
      }
      if (rows.length < 100) break;
      insist(page < 5,409,'Could not reconcile the full GitHub review history.');
    }
    await readOpenPull();
    const row = await api(reviews,{method:'POST',body:{event,commit_id:handoff.sha,body:text},allow:[403,404,409,422]});
    insist(row,409,'GitHub declined the peer review. Check repository permissions and pull request state.');
    const published = receipt(row);
    insist(published,503,'GitHub has not confirmed the published review.');
    await readOpenPull();
    return published;
  }
  async function merge(input,attribution) {
    const actors = mergeAttribution(attribution);
    const {handoff,api,info,path,readPull} = await openSession(input);
    function mergedReceipt(pr) {
      insist(pr.merged === true && shaFormat.test(pr.merge_commit_sha),503,'GitHub has not confirmed the merge.');
      return {sha:handoff.sha,mergeSha:pr.merge_commit_sha,prNumber:pr.number};
    }
    const pr = await readPull();
    if (pr.merged) return mergedReceipt(pr);
    insist(pr.state === 'open' && !pr.draft,409,'The reviewed pull request must be open and ready for merge.');
    insist(pr.mergeable !== false && !['blocked','behind','dirty','draft'].includes(pr.mergeable_state),
      409,'GitHub merge rules or conflicts prevent this merge.');
    insist(pr.mergeable === true && typeof pr.mergeable_state === 'string' && pr.mergeable_state !== 'unknown',
      503,'GitHub is still evaluating merge readiness.');
    // Ask for the repository's aggregate review decision rather than counting reviews or using an admin bypass.
    const query = 'query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { headRefOid baseRefName reviewDecision } } }';
    const rules = await api('/graphql',{method:'POST',body:{query,variables:{
      owner,repo:repository.split('/')[1],number:handoff.pr.number,
    }}});
    const gate = rules?.data?.repository?.pullRequest;
    insist(!rules?.errors?.length && gate && Object.hasOwn(gate,'reviewDecision'),503,'Could not confirm GitHub review requirements.');
    insist(gate.headRefOid === handoff.sha && gate.baseRefName === info.default_branch,409,'The reviewed pull request has changed.');
    insist(gate.reviewDecision === null || gate.reviewDecision === 'APPROVED',409,'GitHub requires an approving review.');
    // The SHA condition is enforced by GitHub on the write. Do not update the base ref directly.
    const mergeMethod = info.allow_merge_commit !== false ? 'merge' : info.allow_squash_merge ? 'squash' : 'rebase';
    const body = {sha:handoff.sha,merge_method:mergeMethod};
    if (actors && mergeMethod !== 'rebase') body.commit_message = mergeTrailers(actors);
    const result = await api(path + '/merge',{method:'PUT',body,
      allow:[403,404,405,409,422]});
    // Re-read the actual PR when GitHub rejects a request or a prior response was lost.
    const after = await readPull();
    if (after.merged) return mergedReceipt(after);
    if (!result?.merged) throw fault(409,'GitHub declined the merge. Verify the PR head, checks and required reviews.');
    throw fault(503,'GitHub has not confirmed the merge.');
  }
  return {
    repo:repository,
    merge,
    publishReview,
    async head() {
      const api=await session();
      const branch=(await repoInfo(api)).default_branch;
      return treeSha((await api(ref(branch))).object);
    },
    async deliver(input) {
      const job=jobSpec(input), api=await session();
      const base=(await repoInfo(api)).default_branch, branch=branchFor(job), path=pathFor(job.projectId);
      const parent=await api('/git/commits/'+job.baseSha);
      insist(treeSha(parent)===job.baseSha,502,'Unexpected Git parent.');
      const root=treeSha(parent.tree), apps=await checkDirectory(api,root,'apps');
      if (apps) await checkDirectory(api,apps,job.projectId);
      // Build only regular blobs under this project, then replace precisely its subtree in the base snapshot.
      const projectTree=treeSha(await api('/git/trees',{method:'POST',body:{tree:job.files.map(f=>({
        path:f.path,content:f.content,mode:'100644',type:'blob'}))}}));
      const tree=treeSha(await api('/git/trees',{method:'POST',body:{base_tree:root,tree:[{path,mode:'040000',type:'tree',sha:projectTree}]}}));
      const who={...author,date:job.createdAt};
      const sha=treeSha(await api('/git/commits',{method:'POST',body:{message:commitMessage(job),tree,parents:[job.baseSha],author:who,committer:who}}));
      await api('/git/refs',{method:'POST',body:{ref:'refs/heads/'+branch,sha},allow:[422]});
      const tip=await api(ref(branch));
      insist(tip.ref==='refs/heads/'+branch && tip.object?.type==='commit' && tip.object.sha===sha,409,'Job branch has a different commit.');
      const query=new URLSearchParams({state:'all',base,head:owner+':'+branch,per_page:'10'}).toString();
      const find=async()=>{
        const pulls=await api('/pulls?'+query);
        insist(Array.isArray(pulls),502,'Invalid GitHub pull request list.');
        return pulls.find(p=>p.head?.ref===branch && p.base?.ref===base &&
          p.head?.repo?.full_name?.toLowerCase()===repository.toLowerCase() && p.base?.repo?.full_name?.toLowerCase()===repository.toLowerCase());
      };
      let pr=await find();
      if (!pr) {
        pr=await api('/pulls',{method:'POST',allow:[422],body:{head:branch,base,title:'Update '+job.projectId,
          body:'Company task '+job.taskId+'\n\nEmployee '+job.agentId+'\n\nJob '+job.jobId,maintainer_can_modify:false}});
        if (!pr) pr=await find();
      }
      insist(pr?.head?.sha===sha && pr.head.ref===branch && pr.base?.ref===base &&
        pr.head.repo?.full_name?.toLowerCase()===repository.toLowerCase() && pr.base.repo?.full_name?.toLowerCase()===repository.toLowerCase() &&
        Number.isSafeInteger(pr.number) && pr.number>0,409,'Could not reconcile the project pull request.');
      return {repo:repository,path,baseSha:job.baseSha,branch,sha,pr:{number:pr.number,url:'https://github.com/'+repository+'/pull/'+pr.number}};
    },
  };
}

export function createRemoteProjectGit({functionName=process.env.PEROTTINO_PROJECTS_GIT_ARN,repository:configured=process.env.PEROTTINO_PROJECTS_REPOSITORY,client}={}) {
  const repository=projectsRepository(configured);
  async function invoke(operation,job,actors) {
    insist(typeof functionName==='string' && functionName,503,'Projects Git worker is not configured.');
    const {LambdaClient,InvokeCommand}=await import('@aws-sdk/client-lambda');
    const transport=client ?? new LambdaClient({maxAttempts:1});
    try {
      const result=await transport.send(new InvokeCommand({FunctionName:functionName,Payload:Buffer.from(JSON.stringify({operation,...(job && {job}),...(actors && {actors})}))}));
      insist(result.StatusCode===200 && !result.FunctionError,503,'Projects Git worker is unavailable.');
      const reply=JSON.parse(Buffer.from(result.Payload).toString('utf8'));
      if (!reply?.ok) throw fault([400,403,409].includes(reply?.status)?reply.status:503,'Projects Git worker declined the operation.');
      return reply.result;
    } finally { if (!client) transport.destroy(); }
  }
  return {repo:repository,head:()=>invoke('head'),deliver:job=>invoke('deliver',jobSpec(job)),
    merge:(handoff,actors)=>invoke('merge',mergeSpec(handoff,repository),mergeAttribution(actors)),
    publishReview:(handoff,review)=>invoke('publishReview',mergeSpec(handoff,repository),reviewSpec(review))};
}

export async function handler(event) {
  if (!['head','deliver','merge','publishReview'].includes(event?.operation)) return {ok:false,status:400};
  try {
    const git=createGitHubProjects({repository:process.env.PEROTTINO_PROJECTS_REPOSITORY,
      getReviewerToken:()=>getProjectsReviewerCredential({secretArn:process.env.PEROTTINO_PROJECTS_GIT_REVIEWER_SECRET_ARN,
        repository:process.env.PEROTTINO_PROJECTS_REPOSITORY}),getToken:async()=>{
      const arn=process.env.PEROTTINO_PROJECTS_GIT_SECRET_ARN;
      insist(Boolean(arn),503,'Projects Git credential unavailable.');
      const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
      const client=new SecretsManagerClient({});
      try { return (await client.send(new GetSecretValueCommand({SecretId:arn}))).SecretString; }
      finally { client.destroy(); }
    }});
    return {ok:true,result:await git[event.operation](event.job,event.actors)};
  } catch (error) {
    // Prevent secret-bearing request objects and provider responses entering application logs.
    return {ok:false,status:[400,403,409].includes(error.status)?error.status:503};
  }
}
