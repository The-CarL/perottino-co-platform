import {createHash,randomUUID} from 'node:crypto';

const digest=(...args)=>createHash('sha256').update(JSON.stringify(args)).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const id=(v)=>typeof v==='string'&&/^[\w.-]{1,160}$/.test(v);
const write=(pk,sk,row,value)=>({pk,sk,expect:row?.version??null,value});
const clean=({pk,sk,version,...data})=>data;
const ttl=15*60_000;
const keys=new Set(['Enter','Tab','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown']);
function origin(raw) {
  let u;try {u=new URL(raw);}catch{fail(400,'Invalid browser origin.');}
  if(u.protocol!=='https:'||u.username||u.password||u.origin!==raw) fail(400,'Supply a complete HTTPS origin.');
  return u.origin;
}
const profileKey=id=>'profile#'+id;
const seatKey=id=>'employee#'+id;
function summary(s,now) {
  return {id:s.id,employeeId:s.employeeId,profileId:s.profileId,controller:s.controller,
    status:s.expiresAt<=now && !['failed','stopped'].includes(s.status)?'expired':s.status,expiresAt:s.expiresAt};
}

export function createManagedBrowser({records,employee,provider,profiles=[],files,now=Date.now}) {
  const pk='browser-sessions',locks='browser-locks';
  const catalog=new Map(profiles.map(p=>[p.id,{id:p.id,label:p.label??p.id,origins:(p.origins??[]).map(origin)}]));
  async function person(actor,requested) {
    const target=requested??(actor==='owner'?'ceo':actor);
    if(actor!=='owner' && target!==actor) fail(403,'Private employee browser.');
    if(!id(target) || !await employee(target)) fail(404,'Employee not found.');
    return target;
  }
  async function execute(actor,op,input={}) {
    if(op==='browser.list') {
      const employeeId=await person(actor,input.employeeId);
      const all=actor==='owner'&&!input.employeeId;
      const page=await records.list(all?'browser-catalog':'browser-list#'+employeeId,{limit:40});
      const sessions=await Promise.all(page.items.map(x=>records.get(pk,x.id)));
      const grants=await records.list(all?'browser-grants-catalog':'browser-grants#'+employeeId,{limit:100});
      return {sessions:sessions.filter(Boolean).map(s=>summary(s,now())),profiles:grants.items.filter(g=>catalog.has(g.id)).map(clean),
        ...(actor==='owner'&&{catalog:[...catalog.values()]})};
    }
    if(!['browser.frame','browser.read','browser.view'].includes(op)&&!id(input.requestId)) fail(400,'Supply a unique browser requestId.');
    if(['browser.profile.grant','browser.profile.revoke'].includes(op)) {
      if(actor!=='owner') fail(403,'Only the owner grants browser profiles.');
      const employeeId=await person(actor,input.employeeId),p=catalog.get(input.profileId);
      if(!p?.origins.length)fail(400,'Select a configured browser profile.');
      const grantPk='browser-grants#'+employeeId,prior=await records.get(grantPk,p.id);
      const allowed=(input.allowedOrigins??p.origins).map(origin);
      if(!allowed.length || allowed.some(o=>!p.origins.includes(o)))fail(403,'Profile origin outside configured policy.');
      const key='profile-change#'+input.requestId,receipt=await records.get('browser-controls',key);
      const signature=digest(op,employeeId,p.id,[...allowed].sort());
      if(receipt){if(receipt.signature!==signature)fail(409,'Request already used.');return {ok:true};}
      const value=op.endsWith('revoke')?null:{id:p.id,employeeId,label:p.label,allowedOrigins:allowed};
      const indexKey=employeeId+'#'+p.id;
      const index=await records.get('browser-grants-catalog',indexKey);
      if(!await records.transact([write(grantPk,p.id,prior,value),write('browser-grants-catalog',indexKey,index,value),write('browser-controls',key,null,{signature})]))fail(409,'Grant changed.');
      return {ok:true};
    }
    if(op==='browser.start') {
      const employeeId=await person(actor,input.employeeId),profileId=input.profileId??null;
      const sessionId='bs-'+digest(actor,input.requestId).slice(0,32);
      const signature=digest(employeeId,profileId,input.url??null);
      let row=await records.get(pk,sessionId);
      if(row && row.signature!==signature)fail(409,'Browser request already used.');
      let origins;
      if(profileId) {
        const grant=await records.get('browser-grants#'+employeeId,profileId);
        if(!grant||!catalog.has(profileId))fail(403,'Profile not granted.');
        origins=grant.allowedOrigins.filter(o=>catalog.get(profileId).origins.includes(o));
        if(!origins.length)fail(403,'Profile has no enabled origins.');
      }
      if(input.url)await provider.validate(input.url,origins);
      if(!row) {
        const at=now(),expiresAt=at+ttl;
        const s={id:sessionId,employeeId,profileId,origins:origins??[],expiresAt,controller:'agent',status:'starting',signature};
        const lockNames=[seatKey(employeeId),...(profileId?[profileKey(profileId)]:[])];
        const held=await Promise.all(lockNames.map(k=>records.get(locks,k)));
        if(held.some(l=>l && l.expiresAt>at))fail(409,'An employee or profile session is already open.');
        const changes=lockNames.map((k,i)=>write(locks,k,held[i],{sessionId,expiresAt}));
        if(!await records.transact([write(pk,sessionId,null,s),write('browser-list#'+employeeId,String(1e14-at)+sessionId,null,{id:sessionId}),write('browser-catalog',String(1e14-at)+sessionId,null,{id:sessionId}),...changes]))
          fail(409,'Session start raced another request. Retry.');
        row=await records.get(pk,sessionId);
      }
      if(row.status==='starting'&&row.expiresAt>now()) {
        const providerId=await provider.start({...row,url:input.url,origins});
        await records.transact([write(pk,row.id,row,{...clean(row),providerId,status:'active'})]);
        row=await records.get(pk,sessionId);
      }
      return {session:summary(row,now())};
    }
    if(!id(input.sessionId)) fail(400,'Invalid browser session.');
    const row=await records.get(pk,input.sessionId);
    if(!row||actor!=='owner'&&actor!==row.employeeId)fail(404,'Browser session not found.');
    if(op==='browser.view')return {session:summary(row,now()),path:'/chat'};
    if(op==='browser.frame'&&actor!=='owner')fail(403,'Owner view required.');
    let origins;
    if(row.profileId && op!=='browser.stop') {
      const grant=await records.get('browser-grants#'+row.employeeId,row.profileId);
      origins=(grant?.allowedOrigins??[]).filter(o=>row.origins.includes(o)&&catalog.get(row.profileId)?.origins.includes(o));
      if(!origins.length)fail(403,'The profile grant has been revoked.');
    }
    const mutation=!['browser.frame','browser.read'].includes(op);
    const receiptPk='browser-actions#'+row.id;
    const signature=digest(op,actor,input.kind??null,input.url??null,input.path??null,input.key??null,input.x??null,input.y??null,Boolean(input.saveProfile));
    if(mutation){
      const old=await records.get(receiptPk,input.requestId);
      if(old){if(old.signature!==signature)fail(409,'Browser request already used.');
        if(!old.done)fail(409,'Browser action outcome is uncertain. Refresh before issuing another input.');
        return {ok:true,session:summary(row,now()),...(old.file&&{file:old.file})};}
    }
    if(row.status!=='active'||row.expiresAt<=now())fail(409,'Browser session is not active.');
    if(['browser.takeover','browser.release'].includes(op) && actor!=='owner')fail(403,'Owner control required.');
    if(['browser.read','browser.input','browser.navigate','browser.stop','browser.download','browser.screenshot'].includes(op) &&
        !(actor==='owner'&&op==='browser.stop') && ((actor==='owner')!==(row.controller==='owner'))) fail(409,'Browser is controlled by another operator.');
    if(row.busyUntil>now())fail(409,'A browser action is in progress. Retry.');
    if(op==='browser.input') {
      const valid=input.kind==='click'?Number.isInteger(input.x)&&Number.isInteger(input.y)&&input.x>=0&&input.y>=0&&input.x<1280&&input.y<800
        :input.kind==='type'?typeof input.text==='string'&&input.text.length<=2000:input.kind==='key'&&keys.has(input.key);
      if(!valid)fail(400,'Invalid input for this browser.');
    }
    if(op==='browser.navigate'||op==='browser.download')await provider.validate(input.url,origins);
    if(op==='browser.frame'||op==='browser.read') {
      const result=await provider.action(row.providerId,op,{},origins);
      const latest=await records.get(pk,row.id);
      if(latest.status!=='active'||latest.controller!==row.controller)fail(409,'Browser control changed.');
      return {...result,controller:row.controller};
    }
    if(!['browser.takeover','browser.release','browser.stop','browser.input','browser.navigate','browser.download','browser.screenshot'].includes(op))fail(404,'Unknown browser operation.');
    const busyId=randomUUID();
    if(!await records.transact([write(pk,row.id,row,{...clean(row),busyId,busyUntil:now()+45_000}),write(receiptPk,input.requestId,null,{signature,done:false})]))
      fail(409,'Browser control changed.');
    let stopped=false,success=false,saved;
    try {
      if(op==='browser.stop') {
        if(input.saveProfile && row.profileId) {
          if(actor!=='owner')fail(403,'Only the owner may publish authenticated profile state.');
          const grant=await records.get('browser-grants#'+row.employeeId,row.profileId);
          if(!grant||!catalog.has(row.profileId))fail(403,'Profile grant has been revoked.');
          await provider.save(row.providerId,row.profileId,input.requestId);
        }
        await provider.stop(row.providerId);stopped=true;
      } else if(['browser.screenshot','browser.download'].includes(op)) {
        if(!files)fail(503,'File storage unavailable.');
        // A signed-in profile can show private documents. Only its owner may
        // explicitly publish pixels or imported documents to company-wide files.
        if(row.profileId && actor!=='owner')fail(403,'Owner is required to publish authenticated profile data.');
        const blob=await provider.action(row.providerId,op,input,origins);
        saved=(await files.execute(actor,'files.write',{path:input.path,contentBase64:blob.contentBase64,
          requestId:digest(row.id,input.requestId)})).file;
      } else if(['browser.input','browser.navigate'].includes(op))await provider.action(row.providerId,op,input,origins);
      success=true;
    } finally {
      const [locked,action]=await Promise.all([records.get(pk,row.id),records.get(receiptPk,input.requestId)]);
      if(locked.busyId!==busyId)fail(409,'Browser lease expired while operating.');
      const next={...clean(locked)};delete next.busyId;delete next.busyUntil;
      if(op==='browser.takeover')next.controller='owner';
      if(op==='browser.release')next.controller='agent';
      if(stopped)next.status='stopped';
      const changes=[write(pk,row.id,locked,next)];
      // A failed input may already have reached the page. Keep the receipt
      // ambiguous instead of replaying a click or password submission.
      if(stopped||op!=='browser.stop'&&success)changes.push(write(receiptPk,input.requestId,action,{signature,done:true,...(saved&&{file:saved})}));
      if(stopped)for(const name of [seatKey(row.employeeId),...(row.profileId?[profileKey(row.profileId)]:[])]) {
        const lock=await records.get(locks,name);if(lock?.sessionId===row.id)changes.push(write(locks,name,lock,null));
      }
      if(!await records.transact(changes))fail(409,'Browser action could not be confirmed.');
    }
    return {ok:true,session:summary(await records.get(pk,row.id),now()),...(saved&&{file:saved})};
  }
  return {execute};
}
