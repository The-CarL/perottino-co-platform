import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { eventRows } from './company-events.mjs';
import { insist,projectFormat,stableId } from './project-source.mjs';

export const queueTemplate='temporary-queue-v1';
const control='INFRA#CONTROL', slotKey='slots', slotsMax=8;
const partition=id=>'INFRA#'+id;
const write=(pk,sk,old,value)=>({pk,sk,expect:old?.version??null,value});
const visible=row=>({resourceId:row.resourceId,projectId:row.projectId,template:queueTemplate,status:row.status,
  createdAt:row.createdAt,expiresAt:row.expiresAt,...(row.url && {url:row.url})});
const conflict=()=>Object.assign(new Error('Infrastructure changed. Retry the same operation.'),{status:409});
const checkRequest=id=>insist(typeof id==='string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id),400,'Invalid request ID.');
const hour=3_600_000;
export function checkSpec(input) {
  insist(input?.template===queueTemplate && typeof input.resourceId==='string' && typeof input.projectId==='string' && /^i-[a-f0-9]{32}$/.test(input.resourceId) && projectFormat.test(input.projectId)
    && Number.isInteger(input.slot) && input.slot>=0 && input.slot<slotsMax,400,'Invalid sandbox resource.');
  for(const time of [input.createdAt,input.expiresAt]) insist(typeof time==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)
    && Number.isFinite(Date.parse(time)),400,'Invalid sandbox lifetime.');
  const lifespan=Date.parse(input.expiresAt)-Date.parse(input.createdAt);
  insist(lifespan>=hour && lifespan<=168*hour,400,'Invalid sandbox lifetime.');
  return {template:queueTemplate,resourceId:input.resourceId,projectId:input.projectId,slot:input.slot,
    createdAt:input.createdAt,expiresAt:input.expiresAt};
}

async function finalize(records,row,status,url) {
  const spec=checkSpec(row),pk=partition(row.projectId);
  const next={...spec,actor:row.actor,status,...(url&&{url})};
  if(status===row.status && (!url || url===row.url)) return visible(row);
  const changes=[write(pk,row.resourceId,row,next)];
  if(status==='removed') {
    const inventory=await records.get(control,slotKey),slots={...inventory?.slots};
    if(slots[row.slot]?.resourceId===row.resourceId) {
      delete slots[row.slot];
      changes.push(write(control,slotKey,inventory,{slots}));
    }
  }
  if(!await records.transact([...changes,...eventRows('infra.'+status,{actor:row.actor,projectId:row.projectId,resourceId:row.resourceId,status},row.resourceId)])) throw conflict();
  return visible(next);
}

async function reconcileRow(records,provider,row,now) {
  if(row.status==='removed') return visible(row);
  const spec=checkSpec(row);
  if(Date.parse(row.expiresAt)<=now() || row.status==='removing') {
    if(row.status!=='removing') {
      if(!await records.transact([write(partition(row.projectId),row.resourceId,row,{...spec,actor:row.actor,status:'removing'})])) throw conflict();
      row=await records.get(partition(row.projectId),row.resourceId);
    }
    const readback=await provider.execute('remove',spec);
    return readback.status==='absent' ? finalize(records,row,'removed') : visible(row);
  }
  const remote=await provider.execute('status',spec);
  if(remote.status==='active') return finalize(records,row,'active',remote.url);
  return row.status==='creating' ? visible(row):finalize(records,row,'removed');
}

export async function reconcileInfrastructure(records,provider,now=Date.now) {
  if(!provider) return;
  const active=await records.get(control,slotKey);
  for(const item of Object.values(active?.slots ?? {})) {
    if(Date.parse(item.expiresAt)>now() && !item.removing) continue;
    const row=await records.get(partition(item.projectId),item.resourceId);
    if(row) await reconcileRow(records,provider,row,now);
  }
}

export function createInfrastructure({records,projects,provider,now=Date.now}) {
  async function access(actor,input) {
    insist(projectFormat.test(input.projectId),400,'Invalid project.');
    await projects.execute(actor,'project.get',{projectId:input.projectId});
  }
  function required() {insist(provider,503,'Install the approved sandbox provisioner for this environment.');}
  async function find(input) {
    insist(/^i-[a-f0-9]{32}$/.test(input.resourceId),400,'Invalid resource ID.');
    const row=await records.get(partition(input.projectId),input.resourceId);
    insist(row,404,'Resource not found.'); return row;
  }
  async function provision(actor,input) {
    await access(actor,input); required(); checkRequest(input.requestId);
    const ttl=input.ttlHours ?? 24;
    insist(input.template===queueTemplate && Number.isInteger(ttl) && ttl>=1 && ttl<=168,400,'Select the approved queue template and a lifetime of 1 to 168 hours.');
    const id=stableId('i',actor,input.projectId,input.requestId);
    const pk=partition(input.projectId);
    for(let retry=0;retry<10;retry++) {
      let row=await records.get(pk,id);
      if(!row) {
        const inventory=await records.get(control,slotKey),slots={...inventory?.slots};
        const slot=Array.from({length:slotsMax},(_,i)=>i).find(i=>!slots[i]);
        if(slot===undefined) {
          if(retry===0) {await reconcileInfrastructure(records,provider,now);continue;}
          insist(false,429,'Company sandbox resource quota reached.');
        }
        const stamp=now();
        const spec={resourceId:id,projectId:input.projectId,slot,template:queueTemplate,
          createdAt:new Date(stamp).toISOString(),expiresAt:new Date(stamp+ttl*hour).toISOString()};
        slots[slot]={projectId:input.projectId,resourceId:id,expiresAt:spec.expiresAt};
        if(!await records.transact([write(pk,id,null,{...spec,actor,status:'creating'}),write(control,slotKey,inventory,{slots}),
          ...eventRows('infra.requested',{actor,projectId:input.projectId,resourceId:id,status:'creating'},id)])) continue;
        row=await records.get(pk,id);
      }
      insist(Date.parse(row.expiresAt)-Date.parse(row.createdAt)===ttl*hour,409,'Request already used with another lifetime.');
      if(row.status!=='creating' || Date.parse(row.expiresAt)<=now()) return reconcileRow(records,provider,row,now);
      const result=await provider.execute('provision',checkSpec(row));
      insist(result.status==='active' && typeof result.url==='string',503,'Sandbox creation awaits readback.');
      try {return await finalize(records,row,'active',result.url);} catch(err){if(err.status!==409) throw err;}
    }
    throw conflict();
  }
  async function remove(actor,input) {
    insist(actor==='owner',403,'The owner must authorize destructive queue removal.');
    await access(actor,input); required(); checkRequest(input.requestId);
    let row=await find(input);
    if(row.status==='removed') return visible(row);
    if(row.status!=='removing') {
      const inventory=await records.get(control,slotKey),slots={...inventory?.slots};
      const changes=[write(partition(row.projectId),row.resourceId,row,{...checkSpec(row),actor:row.actor,status:'removing'})];
      if(slots[row.slot]?.resourceId===row.resourceId) {
        slots[row.slot]={...slots[row.slot],removing:true};
        changes.push(write(control,slotKey,inventory,{slots}));
      }
      if(!await records.transact([...changes,...eventRows('infra.withdrawn',{actor,projectId:row.projectId,resourceId:row.resourceId,status:'removing'},row.resourceId)])) throw conflict();
      row=await find(input);
    }
    return reconcileRow(records,provider,row,now);
  }
  async function list(actor,input) {
    await access(actor,input);
    const limit=input.limit??20;
    insist(Number.isInteger(limit)&&limit>=1&&limit<=50,400,'Invalid page size.');
    const page=await records.list(partition(input.projectId),{prefix:'i-',limit,...(input.after&&{after:input.after})});
    return {resources:page.items.map(visible),enabled:Boolean(provider),...(page.next&&{next:page.next})};
  }
  return {provision,remove,list,async status(actor,input){
    await access(actor,input);required();return reconcileRow(records,provider,await find(input),now);
  }};
}

// The local account has real durable queues, each with a separate SQLite file.
// The local broker exposes only the approved provisioning interface.
export function createLocalInfrastructure({directory,now=Date.now}) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  return {async execute(op,input) {
    const spec=checkSpec(input);
    insist(['provision','status','remove'].includes(op),400,'Invalid sandbox operation.');
    const filename=join(directory,'queue-'+spec.slot+'.sqlite');
    closeSync(openSync(filename,'a',0o600));
    const db=new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS queue_identity (slot INTEGER PRIMARY KEY, spec TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
      const physical=db.prepare('SELECT spec FROM queue_identity WHERE slot=0').get();
      const current=physical && JSON.parse(physical.spec);
      const matches=current?.resourceId===spec.resourceId && current.projectId===spec.projectId && current.expiresAt===spec.expiresAt;
      if(op==='provision') {
        insist(Date.parse(spec.expiresAt)>now(),409,'Sandbox lifetime has elapsed.');
        insist(!current||matches,409,'Sandbox slot is occupied.');
        if(!current) db.prepare('INSERT INTO queue_identity VALUES (0,?)').run(JSON.stringify(spec));
      } else if(op==='remove' && matches) db.exec('DELETE FROM messages; DELETE FROM queue_identity');
      db.exec('COMMIT');
      return op==='provision' || (op==='status' && matches) ? {status:'active',url:'local-queue://'+spec.resourceId} : {status:'absent'};
    } finally {db.close();}
  }};
}

export function createRemoteInfrastructure({origin,region,credentials=defaultProvider(),transport=fetch}) {
  insist(/^[a-z]{2}-[a-z]+-\d$/.test(region),400,'Invalid sandbox region.');
  const uri=new URL(origin);
  insist(new RegExp('^[a-z0-9]{10}\\.execute-api\\.'+region+'\\.amazonaws\\.com$').test(uri.hostname) &&
    uri.origin===origin && uri.protocol==='https:' && !uri.username && !uri.password,400,'Invalid configured sandbox endpoint.');
  const signer=new SignatureV4({credentials,region,service:'execute-api',sha256:Sha256});
  return {async execute(operation,input) {
    const body=JSON.stringify({operation,spec:checkSpec(input)});
    const path='/sandbox/resources';
    const signed=await signer.sign(new HttpRequest({method:'POST',protocol:'https:',hostname:uri.hostname,path,
      headers:{host:uri.hostname,'content-type':'application/json','x-amz-content-sha256':createHash('sha256').update(body).digest('hex')},body}));
    const response=await transport(origin+path,{method:'POST',headers:signed.headers,body,redirect:'error',signal:AbortSignal.timeout(12_000)});
    if(!response.ok) throw Object.assign(new Error('Approved sandbox provider declined or is unavailable.'),
      {status:response.status===409?409:503});
    const result=await response.json();
    if(['absent','removing'].includes(result.status)) return {status:result.status};
    insist(result.status==='active' && typeof result.url==='string' && result.url.startsWith('https://sqs.'+region+'.amazonaws.com/'),
      503,'Invalid sandbox provider readback.');
    return {status:'active',url:result.url};
  }};
}
