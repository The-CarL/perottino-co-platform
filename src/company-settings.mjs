import { createHash } from 'node:crypto';
import { eventRows } from './company-events.mjs';
import { fileRequest } from './company-files.mjs';
const fail=(status,msg)=>{throw Object.assign(new Error(msg),{status});};
const plain=v=>v && typeof v==='object' && !Array.isArray(v) && Object.getPrototypeOf(v)===Object.prototype;
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function createSettings({records,employee,modelIds}) {
  if(!modelIds?.length) throw new Error('Missing Bedrock model configuration');
  const defaults={modelId:modelIds[0],reasoningEffort:'medium',pulseSeconds:30,maxSteps:6,networkAccess:true,mandate:'Await the owner’s instructions.'};
  const valid={networkAccess:v=>typeof v==='boolean',modelId:v=>modelIds.includes(v),reasoningEffort:v=>['low','medium','high'].includes(v),
    pulseSeconds:v=>Number.isInteger(v)&&v>=5&&v<=3600,maxSteps:v=>Number.isInteger(v)&&v>=1&&v<=6,
    mandate:v=>typeof v==='string' && v.trim().length>0 && v.length<=4000};
  async function key(scope,target) {
    if(scope==='company' && !target) return 'company';
    if(!['role','employee'].includes(scope) || typeof target!=='string' || !target.trim() || target.length>120) fail(400,'Invalid settings scope.');
    if(scope==='employee' && !await employee(target)) fail(404,'Employee not found.');
    return scope+'#'+(scope==='role'?target.trim().toLowerCase():target);
  }
  async function effective(actor,input) {
    const id=input.employeeId ?? actor;
    if(actor!=='owner' && id!==actor) fail(403,'Cannot inspect another employee’s configuration.');
    const person=id==='owner'?null:await employee(id);
    if(id!=='owner'&&!person) fail(404,'Employee not found.');
    const scopes=['company',...(person?['role#'+person.role.trim().toLowerCase(),'employee#'+person.id]:[])];
    const rows=await Promise.all(scopes.map(s=>records.get('settings',s)));
    const settings={...defaults};
    const origins=Object.fromEntries(Object.keys(defaults).map(k=>[k,'default']));
    rows.forEach((r,i)=>{for(const [k,v] of Object.entries(r?.settings ?? {})){settings[k]=v;origins[k]=scopes[i];}});
    return {settings,origins,version:fingerprint([settings,scopes.map((s,i)=>[s,rows[i]?.revision ?? 0])])};
  }
  async function execute(actor,op,input) {
    if(op==='settings.effective') return effective(actor,input);
    if(actor!=='owner') fail(403,'Owner access required.');
    const sk=await key(input.scope ?? 'company',input.target);
    const pk='settings-history#'+sk;
    const current=await records.get('settings',sk);
    if(op==='settings.get') return {settings:current?.settings ?? {},version:current?.revision ?? 0,modelIds};
    if(op==='settings.history') {
      const page=await records.list(pk,{limit:40,...(input.after&&{after:input.after})});
      return {revisions:page.items.map(r=>({version:r.revision,settings:r.settings,at:r.at})),...(page.next&&{next:page.next})};
    }
    if(!['settings.update','settings.restore'].includes(op)) fail(404,'Unknown settings operation.');
    const requestId=fileRequest(input.requestId), request='settings-request';
    const signature=fingerprint([sk,op,input.settings ?? null,input.revision ?? null,input.expectedVersion ?? null]);
    const replay=async()=>{const row=await records.get(request,requestId);if(row && row.signature!==signature) fail(409,'Settings requestId already used.');return row?.result;};
    const done=await replay();if(done)return done;
    if(input.expectedVersion!==undefined && input.expectedVersion!==(current?.revision ?? 0)) fail(409,'Configuration was changed by another publisher.');
    let settings;
    if(op==='settings.restore') {
      if(!Number.isSafeInteger(input.revision)||input.revision<1) fail(400,'Invalid revision.');
      const historical=await records.get(pk,String(1e12-input.revision));
      if(!historical) fail(404,'Revision not found.');
      settings=historical.settings;
    } else {
      if(!plain(input.settings)) fail(400,'Invalid settings.');
      settings={...current?.settings};
      for(const [k,v] of Object.entries(input.settings)) {
        if(!Object.hasOwn(valid,k) || v!==null && !valid[k](v)) fail(400,'Unsupported configuration value.');
        if(v===null) delete settings[k]; else settings[k]=v;
      }
    }
    const revision=(current?.revision ?? 0)+1, value={settings,revision,at:new Date().toISOString()};
    const result={settings,version:revision};
    if(await records.transact([{pk:'settings',sk,expect:current?.version ?? null,value},
      {pk,sk:String(1e12-revision),expect:null,value},{pk:request,sk:requestId,expect:null,value:{signature,result}},
      ...eventRows('settings.published',{actor},requestId)])) return result;
    return (await replay()) ?? fail(409,'Retry after refreshing the settings.');
  }
  return {execute,effective};
}
