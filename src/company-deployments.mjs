import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { makeDynamoRecords } from './foundation-records.mjs';
import { eventRows } from './company-events.mjs';
import { insist, projectFormat, shaFormat, stableId } from './project-source.mjs';
import { mediaTypes, templateId, validateReport } from './static-template.mjs';

const previewKey = 'PUBLICSITE#PREVIEW', prodKey = 'PUBLICSITE#PRODUCTION';
const limits = { dailyBuilds:32, projectBuilds:64, previews:8, previewHours:168 };
const buildFormat = /^b-[a-f0-9]{32}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = (pk, sk, old, value) => ({pk,sk,expect:old?.version ?? null,value});
const busy = () => Object.assign(new Error('Delivery changed. Retry the same request.'),{status:409});
const publicBuild = row => row ? {
  projectId:row.projectId, taskId:row.taskId, buildId:row.buildId, commitSha:row.commitSha, template:templateId,
  status:row.status, testsPassed:row.testsPassed ?? 0, ...(row.reason && {reason:row.reason}),
} : null;
const receipt = row => row?.publication ?? null;

function identity(input) {
  insist(projectFormat.test(input?.projectId),400,'Invalid project.');
  return 'DEPLOY#' + input.projectId;
}
function request(input) {
  insist(typeof input.requestId === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(input.requestId),400,'Invalid request ID.');
}
function originOf(value) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid delivery origin.');
  return url.origin;
}

export function createDeployments({records,projects,execute,origin,governance,policy={},now=Date.now}) {
  const host = originOf(origin);
  const caps = {...limits};
  for(const key of Object.keys(limits)) {
    if (policy[key] !== undefined) {
      insist(Number.isInteger(policy[key]) && policy[key]>=1 && policy[key]<=limits[key],400,'Invalid delivery quota.');
      caps[key]=policy[key];
    }
  }
  const productionAgents = policy.productionAgents ?? [];
  insist(Array.isArray(productionAgents) && productionAgents.every(item => typeof item?.agentId === 'string' &&
    projectFormat.test(item.projectId)),400,'Production policy requires exact project and employee IDs.');

  async function authorized(actor,input) {
    const snapshot = await projects.getSnapshot(actor,{projectId:input.projectId,taskId:input.taskId,commitSha:input.commitSha});
    insist(snapshot?.projectId===input.projectId && snapshot.taskId===input.taskId && snapshot.commitSha===input.commitSha,
      403,'Snapshot does not match the authorized task.');
    return snapshot;
  }
  async function build(actor,input) {
    const pk=identity(input);
    request(input);
    insist(shaFormat.test(input.commitSha),400,'A committed Git SHA is required.');
    const snapshot=await authorized(actor,input);
    const buildId=stableId('b',templateId,input.projectId,input.taskId,input.commitSha);
    const binding={projectId:input.projectId,taskId:input.taskId,commitSha:input.commitSha,buildId};
    for(let retry=0;retry<12;retry++) {
      let row=await records.get(pk,buildId);
      if(row && row.status!=='testing') return publicBuild(row);
      const stamp=now(), day=new Date(stamp).toISOString().slice(0,10);
      if(row && row.leaseUntil>stamp) return publicBuild(row);
      const preparing=Boolean(row && row.actor===actor && !row.dispatched);
      const attempt=preparing ? row.attempt : randomUUID();
      const lease=randomUUID();
      const next={...binding,actor,attempt,lease,status:'testing',dispatched:false,leaseUntil:stamp+25_000};
      const changes=[write(pk,buildId,row,next)];
      if(!preparing) {
        const [dayRow,projectRow]=await Promise.all([records.get('DELIVERY#QUOTA','daily'),records.get(pk,'quota')]);
        const daily=dayRow?.day===day ? dayRow.count : 0;
        insist(daily<caps.dailyBuilds,429,'Daily company build quota reached.');
        insist(row || (projectRow?.count ?? 0)<caps.projectBuilds,429,'Project build retention quota reached.');
        changes.push(write('DELIVERY#QUOTA','daily',dayRow,{day,count:daily+1}));
        if(!row) changes.push(write(pk,'quota',projectRow,{count:(projectRow?.count ?? 0)+1}));
      }
      if(!await records.transact(changes)) continue;
      row=await records.get(pk,buildId);
      if(row?.lease!==lease) throw busy();
      if(governance) {
        // A debit is a policy unit per dispatch attempt. Both calls recover by
        // the same ID if a process dies during admission. Only the subsequent
        // fenced transition authorizes the expensive external invocation.
        try {
          const held=await governance.execute(actor,'budget.reserve',{requestId:'build.'+attempt,amountCents:1,purpose:'preview',taskId:snapshot.taskId,projectId:snapshot.projectId});
          await governance.execute(actor,'budget.settle',{requestId:'settle.'+attempt,reservationId:held.reservation.id,actualCents:1});
        } catch(err) {
          await records.transact([write(pk,buildId,row,{...next,leaseUntil:0})]);
          throw err;
        }
      }
      const dispatched={...next,dispatched:true,leaseUntil:now()+25_000};
      if(!await records.transact([write(pk,buildId,row,dispatched)])) throw busy();
      row=await records.get(pk,buildId);
      if(row?.lease!==lease || row.leaseUntil<=now()) throw busy();
      const report=validateReport(await execute({template:templateId,files:snapshot.files}));
      const {files,...result}=report;
      const finished={...binding,actor,...result,...(files && {files})};
      if(!await records.transact([write(pk,buildId,row,finished),...eventRows('delivery.build',
        {actor,taskId:row.taskId,projectId:row.projectId,buildId,status:result.status},buildId)])) throw busy();
      return publicBuild(finished);
    }
    throw busy();
  }

  async function publish(actor,input,kind) {
    const pk=identity(input); request(input);
    const prod=kind!=='preview';
    if(prod) insist(actor==='owner' || productionAgents.some(a=>a.agentId===actor && a.projectId===input.projectId),
      403,'Production release requires authority for this project.');
    const ttl=input.ttlHours ?? Math.min(24,caps.previewHours);
    if(!prod) insist(Number.isInteger(ttl) && ttl>=1 && ttl<=caps.previewHours,400,'Invalid preview lifetime.');
    if(kind!=='rollback') insist(buildFormat.test(input.buildId),400,'Invalid build.');
    const reqKey='receipt#'+hash([actor,kind,input.requestId]);
    const fingerprint=hash([input.projectId,input.buildId ?? null,prod ? null : ttl]);
    for(let retry=0;retry<12;retry++) {
      const prior=await records.get(pk,reqKey);
      if(prior) {
        insist(prior.fingerprint===fingerprint,409,'This request was already used with different input.');
        await authorized(actor,prior.publication);
        return prior.publication;
      }
      const stamp=now();
      const group=prod ? prodKey : previewKey;
      const current=await records.get(group,input.projectId);
      const targetId=kind==='rollback' ? current?.publication.previousBuildId : input.buildId;
      insist(targetId,409,'No previous release exists.');
      const candidate=await records.get(pk,targetId);
      insist(candidate?.status==='passed',409,'A passed build is required.');
      await authorized(actor,candidate);
      const publication={projectId:input.projectId, taskId:candidate.taskId, buildId:targetId,commitSha:candidate.commitSha,
        url:host+(prod ? '/p/'+input.projectId+'/' : '/v/'+input.projectId+'/'+targetId+'/'),
        ...(prod ? current && {previousBuildId:current.publication.buildId===targetId ?
            current.publication.previousBuildId ?? null : current.publication.buildId} :
          {expiresAt:new Date(stamp+ttl*3600_000).toISOString()})};
      const changes=[write(group,input.projectId,current,{publication,files:candidate.files}),
        write(pk,reqKey,null,{fingerprint,publication})];
      if(!prod) {
        const slots=await records.get('DELIVERY#QUOTA','previews');
        const active=Object.fromEntries(Object.entries(slots?.active ?? {}).filter(([,expiry])=>expiry>stamp));
        insist(Object.hasOwn(active,input.projectId)||Object.keys(active).length<caps.previews,429,'Active preview quota reached.');
        active[input.projectId]=Date.parse(publication.expiresAt);
        changes.push(write('DELIVERY#QUOTA','previews',slots,{active}));
        // A small global expiry index supports bounded cleanup even when the quota slot is reused.
        changes.push(write('DELIVERY#EXPIRY',input.projectId,await records.get('DELIVERY#EXPIRY',input.projectId),
          {expiresAt:publication.expiresAt}));
      }
      if(await records.transact([...changes,...eventRows('delivery.'+kind,{actor,taskId:candidate.taskId,projectId:input.projectId,buildId:targetId,status:'published'},
        reqKey+'#'+input.projectId)])) return publication;
    }
    throw busy();
  }
  async function withdraw(actor,input,production) {
    insist(actor==='owner',403,'The owner must authorize site withdrawal.');
    const pk=identity(input); request(input);
    insist(buildFormat.test(input.buildId),400,'The current build ID is required.');
    const group=production ? prodKey:previewKey;
    const kind=production ? 'withdraw':'expire';
    const key='receipt#'+hash([actor,kind,input.requestId]);
    for(let retry=0;retry<12;retry++) {
      const [prior,current]=await Promise.all([records.get(pk,key),records.get(group,input.projectId)]);
      if(prior) {
        insist(prior.result.buildId===input.buildId,409,'This request was already used for a different build.');
        return prior.result;
      }
      insist(current?.publication.buildId===input.buildId,409,'The live site changed. Review its current build.');
      await authorized(actor,current.publication);
      const result={projectId:input.projectId,buildId:input.buildId,status:'withdrawn'};
      const changes=[write(group,input.projectId,current,null),write(pk,key,null,{result})];
      if(!production) {
        const slots=await records.get('DELIVERY#QUOTA','previews');
        if(slots) {
          const active={...slots.active}; delete active[input.projectId];
          changes.push(write('DELIVERY#QUOTA','previews',slots,{active}));
        }
        const expires=await records.get('DELIVERY#EXPIRY',input.projectId);
        if(expires) changes.push(write('DELIVERY#EXPIRY',input.projectId,expires,null));
      }
      if(await records.transact([...changes,...eventRows('delivery.'+kind.toLowerCase(),{actor,taskId:current.publication.taskId,
        status:'withdrawn'},key+'#'+input.projectId)])) return result;
    }
    throw busy();
  }
  async function status(actor,input) {
    const pk=identity(input); await authorized(actor,input);
    const buildId=stableId('b',templateId,input.projectId,input.taskId,input.commitSha);
    const [build,preview,production]=await Promise.all([records.get(pk,buildId),
      records.get(previewKey,input.projectId),records.get(prodKey,input.projectId)]);
    return {projectId:input.projectId,build:publicBuild(build),
      preview:preview && Date.parse(preview.publication.expiresAt)>now() ? receipt(preview):null,production:receipt(production)};
  }
  return {build,preview:(actor,i)=>publish(actor,i,'preview'),release:(actor,i)=>publish(actor,i,'release'),
    rollback:(actor,i)=>publish(actor,i,'rollback'),withdraw:(actor,i)=>withdraw(actor,i,true),
    expire:(actor,i)=>withdraw(actor,i,false),status};
}

export async function expirePreviews(records,now=Date.now) {
  let after, removed=0;
  do {
    const page=await records.list('DELIVERY#EXPIRY',{limit:50,...(after && {after})});
    for(const row of page.items) {
      if(Date.parse(row.expiresAt)>now()) continue;
      const site=await records.get(previewKey,row.sk);
      if(site && site.publication.expiresAt!==row.expiresAt) continue;
      const changes=[write('DELIVERY#EXPIRY',row.sk,row,null)];
      if(site) changes.push(write(previewKey,row.sk,site,null));
      if(await records.transact(changes)) removed++;
    }
    after=page.next;
  } while(after);
  return removed;
}

export function createLambdaExecutor(arn,client=new LambdaClient({})) {
  return async input=>{
    const res=await client.send(new InvokeCommand({FunctionName:arn,Payload:Buffer.from(JSON.stringify(input))}));
    if(res.FunctionError || !res.Payload) throw new Error('Build executor unavailable.');
    return JSON.parse(Buffer.from(res.Payload).toString('utf8'));
  };
}

export function createDockerExecutor({image='perottino-delivery:local'}={}) {
  if(!/^[a-z0-9][a-z0-9./:@_-]{0,240}$/.test(image)) throw new Error('Invalid configured build image.');
  return input=>new Promise((resolve,reject)=>{
    const child=spawn('docker',['run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL',
      '--security-opt','no-new-privileges','--pids-limit','32','--cpus','0.5','--memory','128m','--memory-swap','128m',
      '--user','1000:1000','-i',image],{stdio:['pipe','pipe','ignore'],timeout:15_000});
    let size=0;
    const parts=[];
    child.stdin.on('error',()=>{});
    child.once('error',()=>reject(new Error('Local build executor unavailable.')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>512*1024) child.kill();else parts.push(chunk);});
    child.once('close',code=>{
      try {
        if(code!==0 || size>512*1024) throw new Error();
        resolve(validateReport(JSON.parse(Buffer.concat(parts).toString('utf8'))));
      } catch{reject(new Error('Local build image unavailable or invalid.'));}
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'access-control-allow-origin':'*','permissions-policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'"};
export async function serveDelivery(records,{method='GET',path},now=Date.now) {
  if(!['GET','HEAD'].includes(method)) return {statusCode:405,headers,body:''};
  const missing={statusCode:404,headers,body:''};
  const match=/^\/(p|v)\/(p-[0-9a-f]{32})\/(.*)$/.exec(path);
  if(!match || path.length>250) return missing;
  const [,kind,project,rest]=match;
  const segments=rest.split('/');
  const token=kind==='v' ? segments.shift():undefined;
  if(kind==='v' && !buildFormat.test(token)) return missing;
  const relative=segments.join('/') || 'index.html';
  if(!relative.split('/').every(p=>/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(p))) return missing;
  const site=await records.get(kind==='v' ? previewKey:prodKey,project);
  if(!site || (kind==='v' && (site.publication.buildId!==token || Date.parse(site.publication.expiresAt)<=now()))) return missing;
  const file=site.files.find(item=>item.path==='public/'+relative);
  const type=mediaTypes.get(relative.slice(relative.lastIndexOf('.')));
  if(!file || !type) return missing;
  return {statusCode:200,headers:{...headers,'content-type':type},body:method==='HEAD' ? '' : file.content};
}

let publicRecords;
export function publicHandler(event) {
  publicRecords ??= makeDynamoRecords({tableName:process.env.PEROTTINO_STATE_TABLE});
  return serveDelivery(publicRecords,{method:event.requestContext?.http?.method,path:event.rawPath});
}

export async function startLocalDelivery({records,host='127.0.0.1',port=0}) {
  if(!['127.0.0.1','::1'].includes(host)) throw new Error('Local preview must bind to loopback.');
  const server=createServer(async (req,res)=>{
    try {
      const reply=await serveDelivery(records,{method:req.method,path:(req.url ?? '/').split('?')[0]});
      res.writeHead(reply.statusCode,reply.headers).end(reply.body);
    } catch {res.writeHead(503,headers).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {origin:'http://'+(host==='::1'?'[::1]':host)+':'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
