import { author, branchFor, commitMessage, fault, insist, jobSpec, pathFor, projectsRepository, shaFormat } from './project-source.mjs';

export function createGitHubProjects({ repository: configured, getToken, fetchImpl=fetch }) {
  const repository=projectsRepository(configured);
  const apiRoot='https://api.github.com/repos/'+repository;
  const owner=repository.split('/')[0];
  async function session() {
    const token=await getToken();
    insist(typeof token==='string' && token.length>0 && token.length<=4096 && !/[\r\n]/.test(token),503,'Projects Git credential unavailable.');
    return async function request(path,{method='GET',body,allow=[]}={}) {
      const result=await fetchImpl(apiRoot+path,{method,redirect:'error',signal:AbortSignal.timeout(12_000),
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
  async function baseBranch(api) {
    const info=await api('');
    insist(info.full_name?.toLowerCase()===repository.toLowerCase() && typeof info.private==='boolean' && !info.archived,403,'Expected the configured writable projects repository.');
    insist(typeof info.default_branch==='string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,160}$/.test(info.default_branch)
      && !info.default_branch.includes('..'),502,'Invalid default branch.');
    return info.default_branch;
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
  return {
    repo:repository,
    async head() {
      const api=await session();
      const branch=await baseBranch(api);
      return treeSha((await api(ref(branch))).object);
    },
    async deliver(input) {
      const job=jobSpec(input), api=await session();
      const base=await baseBranch(api), branch=branchFor(job), path=pathFor(job.projectId);
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
  async function invoke(operation,job) {
    insist(typeof functionName==='string' && functionName,503,'Projects Git worker is not configured.');
    const {LambdaClient,InvokeCommand}=await import('@aws-sdk/client-lambda');
    const transport=client ?? new LambdaClient({maxAttempts:1});
    try {
      const result=await transport.send(new InvokeCommand({FunctionName:functionName,Payload:Buffer.from(JSON.stringify({operation,...(job && {job})}))}));
      insist(result.StatusCode===200 && !result.FunctionError,503,'Projects Git worker is unavailable.');
      const reply=JSON.parse(Buffer.from(result.Payload).toString('utf8'));
      if (!reply?.ok) throw fault([400,403,409].includes(reply?.status)?reply.status:503,'Projects Git worker declined the operation.');
      return reply.result;
    } finally { if (!client) transport.destroy(); }
  }
  return {repo:repository,head:()=>invoke('head'),deliver:job=>invoke('deliver',jobSpec(job))};
}

export async function handler(event) {
  if (!['head','deliver'].includes(event?.operation)) return {ok:false,status:400};
  try {
    const git=createGitHubProjects({repository:process.env.PEROTTINO_PROJECTS_REPOSITORY,getToken:async()=>{
      const arn=process.env.PEROTTINO_PROJECTS_GIT_SECRET_ARN;
      insist(Boolean(arn),503,'Projects Git credential unavailable.');
      const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
      const client=new SecretsManagerClient({});
      try { return (await client.send(new GetSecretValueCommand({SecretId:arn}))).SecretString; }
      finally { client.destroy(); }
    }});
    return {ok:true,result:event.operation==='head'?await git.head():await git.deliver(event.job)};
  } catch (error) {
    // Prevent secret-bearing request objects and provider responses entering application logs.
    return {ok:false,status:[400,403,409].includes(error.status)?error.status:503};
  }
}
