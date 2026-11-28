import {interactiveResource} from './browser.mjs';
import {shaFormat} from './project-source.mjs';
// Trusted runtime supplies actor, work IDs, lease and idempotency keys. Decisions
// describe business inputs only; no decision can call a generic broker command.
export const capabilityFields = {
  'messages.receipts':{peerId:'?string',conversationId:'?string',messageId:'?string',expectedText:'?string',beforeSeq:'?integer'},
  'files.list':{prefix:'?string',after:'?string'}, 'files.read':{path:'string',version:'?integer'},
  'files.write':{path:'string',text:'string',expectedVersion:'?integer'}, 'files.versions':{path:'string'},
  'soul.get':{}, 'settings.effective':{}, 'knowledge.list':{projectId:'?string'},
  'knowledge.save':{text:'string',projectId:'?string'}, 'knowledge.forget':{memoryId:'string'},
  'search':{query:'string'}, 'browser.list':{}, 'browser.start':{profileId:'?string',url:'?string'},
  'browser.navigate':{sessionId:'string',url:'string'},'browser.read':{sessionId:'string'},
  'browser.input':{sessionId:'string',kind:'inputKind',x:'?integer',y:'?integer',key:'?string',text:'?string'},
  'browser.download':{sessionId:'string',url:'string',path:'string'},'browser.screenshot':{sessionId:'string',path:'string'},
  'browser.stop':{sessionId:'string',saveProfile:'?boolean'},
  'mail.send':{to:'string',subject:'string',text:'string'},
  'mail.reply':{threadId:'string',messageId:'string',text:'string'}, 'mail.list':{}, 'mail.get':{threadId:'string'},
  'promotion.list':{after:'?string'}, 'governance.get':{employeeId:'?string'}, 'promotion.propose':{employeeId:'string',evidenceTaskIds:'array',
    firstHireCase:'string',projectId:'string',roles:'array',maxDirectReports:'integer',maxAllocationCents:'integer'},
  'promotion.approve':{proposalId:'string'}, 'grant.revoke':{employeeId:'string'},
  'budget.allocate':{employeeId:'string',amountCents:'integer'},
  'project.create':{name:'string'}, 'project.list':{goalId:'?string'}, 'project.get':{projectId:'string'},
  'project.history':{projectId:'string',after:'?string'}, 'project.attach':{projectId:'string',goalId:'string'},
  'project.snapshot':{projectId:'string',taskId:'string',commitSha:'string',path:'?string',offset:'?integer'},
  'project.commit':{projectId:'string',baseSha:'?string',files:'files',remove:'?array'},
  'delivery.build':{projectId:'string',commitSha:'string'},
  'delivery.preview':{projectId:'string',buildId:'string',ttlHours:'?integer'},
  'infra.provision':{projectId:'string',ttlHours:'integer'}, 'infra.status':{projectId:'string',resourceId:'string'},
  'delivery.release':{projectId:'string',buildId:'string'},'delivery.rollback':{projectId:'string'},
  'delivery.status':{projectId:'string',taskId:'string',commitSha:'string'},
};
const read = ['files.list','files.read','files.versions','soul.get','settings.effective','knowledge.list','search',
  'governance.get','promotion.list','project.list','project.get','project.history','project.snapshot','delivery.status','infra.status'];
const browser = ['browser.list','browser.start','browser.navigate','browser.read','browser.input','browser.stop','browser.download','browser.screenshot'];
const write = ['files.write','knowledge.save','knowledge.forget','promotion.propose','mail.list','mail.get','mail.send','mail.reply', ...browser];

export function capabilitiesFor(ctx) {
  if (ctx.kind === 'mail' && !ctx.trustedOwner || ctx.kind === 'message' && ctx.message.senderId !== 'owner' &&
      (!ctx.agent.managerId || ctx.message.senderId !== ctx.agent.managerId)) return [];
  const ops = [...read];
  if (ctx.kind === 'task' || ctx.kind === 'review') ops.push('messages.receipts');
  if (!['review','close'].includes(ctx.kind)) ops.push(...write);
  if (ctx.kind === 'task') ops.push('project.create','project.commit','delivery.build','delivery.preview','delivery.release','delivery.rollback','infra.provision');
  if (['message','plan','mail','task'].includes(ctx.kind)) ops.push('project.attach','budget.allocate');
  if (ctx.agent.id === 'ceo' && ['message','plan','mail','task'].includes(ctx.kind)) ops.push('promotion.approve','grant.revoke');
  return ops;
}

// Defend the journal's bounded footprint independently of any service's response.
function small(value,budget=10000) {
  let left=budget;
  function visit(v) {
    if (typeof v==='string') { const result=v.slice(0,Math.min(6000,left)); left-=result.length; return result; }
    if (v===null || typeof v!=='object') return v;
    const result=Array.isArray(v)?[]:{};
    for(const [key,child] of Object.entries(v).slice(0,28)) {
      if(left<120) break;
      if(child===undefined)continue;
      if(['contentBase64','dataUrl','token','capability','providerId','claimToken','traceContext','pk','sk'].includes(key)) continue;
      left-=key.length+16;
      result[key]=visit(child);
    }
    return result;
  }
  return visit(value);
}

const firstCommitHelp = 'This project has no committed handoff. Submit the initial files with project.commit and omit baseSha. The Git worker resolves the repository default branch.';

export async function useCapability(op,input,{ctx,unit,execute,call,browse,signal}) {
  if (!Object.hasOwn(capabilityFields,op)) throw new Error('Unknown employee capability.');
  if (op === 'search') {
    const url='https://html.duckduckgo.com/html/?q='+encodeURIComponent(input.query.slice(0,360));
    try {
      const response=await interactiveResource({raw:url,method:'GET',signal});
      if(response.status===200) {
        const results=parseSearchResults(response.body.toString('utf8'));
        if(results.length)return {provider:'DuckDuckGo',results};
      }
    }catch(error){signal?.throwIfAborted();}
    // A credential-free search provider. Resolve and fetch through the ordinary
    // public reader; result bodies are untrusted reference material.
    const page=await browse('https://en.wikipedia.org/w/index.php?search='+encodeURIComponent(input.query),{signal});
    return {provider:'Wikipedia',url:page.url,title:page.title,text:String(page.text).slice(0,4000)};
  }
  if (op === 'project.list') return small(await execute(op,{...input,goalId:input.goalId??ctx.goal?.id,limit:12}));
  if (op === 'project.create') return small(await call(op,{name:input.name,goalId:ctx.goal.id,taskId:unit.task.id}));
  if (op === 'project.snapshot') {
    if (!shaFormat.test(input.commitSha)) {
      const {project} = await execute('project.get',{projectId:input.projectId});
      if (!project.latestHandoff) return {error:firstCommitHelp};
      const {taskId,sha} = project.latestHandoff;
      return {error:'Use the producing task ID and exact commit SHA from a project handoff.',latest:{taskId,commitSha:sha}};
    }
    const snapshot=await execute(op,{projectId:input.projectId,taskId:input.taskId,commitSha:input.commitSha});
    if (!input.path) return {commitSha:snapshot.commitSha,files:snapshot.files.map(f=>({path:f.path,size:f.content.length}))};
    const file=snapshot.files.find(f=>f.path===input.path);
    if(!file) return {error:'File is absent from the requested commit.'};
    const offset=input.offset??0;
    return {path:file.path,commitSha:snapshot.commitSha,offset,content:file.content.slice(offset,offset+6500),
      ...(offset+6500<file.content.length&&{nextOffset:offset+6500})};
  }
  if(op==='project.commit') {
    const {project}=await execute('project.get',{projectId:input.projectId});
    const baseSha=input.baseSha??null;
    const paths=new Map();
    // Always use the recorded, exact base that the employee actually read, then
    // preserve untouched files. The Git broker rejects an obsolete base.
    if(baseSha) {
      if (!project.latestHandoff) return {error:firstCommitHelp};
      const history=await execute('project.history',{projectId:project.id,limit:100});
      const handoff=history.handoffs.find(h=>h.sha===baseSha);
      if (!handoff) return {error:'The base revision is outside the recent project history. Refresh the project.'};
      const base=await execute('project.snapshot',{projectId:project.id,taskId:handoff.taskId,commitSha:baseSha});
      for(const file of base.files) paths.set(file.path,file);
    }
    for(const path of input.remove??[]) paths.delete(path);
    for(const file of input.files) paths.set(file.path,file);
    return small(await call(op,{projectId:project.id,taskId:unit.task.id,baseSha,files:[...paths.values()]}));
  }
  if(op==='infra.provision')return small(await call(op,{...input,template:'temporary-queue-v1'}));
  if(op==='delivery.build') return small(await call(op,{...input,taskId:unit.task.id}));
  if(op==='mail.get') {
    const result=await execute(op,input);
    return small({thread:result.thread,messages:result.messages?.map(({id,subject,text,from,createdAt})=>({id,subject,text,from,createdAt}))});
  }
  if(op==='files.read') {
    const {file}=await execute(op,input);
    return small({file:{path:file.path,version:file.version,sha256:file.sha256,size:file.size,text:file.text,
      ...(file.contentBase64&&{encoding:'binary'})}});
  }
  return small(await call(op,input));
}

export function parseSearchResults(html) {
  const results=[];
  const unescape=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
  for(const match of html.matchAll(/<a\b([^>]{1,5000})>([\s\S]{1,1500}?)<\/a>/gi)) {
    if(!/class=["'][^"']*\bresult__a\b/.test(match[1]))continue;
    const href=/\bhref=["']([^"']+)["']/i.exec(match[1]);if(!href)continue;
    try {
      let url=new URL(unescape(href[1]),'https://duckduckgo.com');
      if(['duckduckgo.com','www.duckduckgo.com'].includes(url.hostname)&&url.searchParams.has('uddg'))url=new URL(url.searchParams.get('uddg'));
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.href.length>2000)continue;
      const title=unescape(match[2].replace(/<[^>]*>/g,'')).trim().slice(0,240);
      if(title)results.push({title,url:url.href});
      if(results.length===8)break;
    }catch{}
  }
  return results;
}
