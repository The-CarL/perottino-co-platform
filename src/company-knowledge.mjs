import {createHash} from 'node:crypto';
import {fileRequest} from './company-files.mjs';
import {eventRows} from './company-events.mjs';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const note=r=>({id:r.sk,employeeId:r.employeeId,...(r.projectId&&{projectId:r.projectId}),text:r.text,
  source:r.source,authorId:r.authorId,pinned:r.pinned,createdAt:r.createdAt,updatedAt:r.updatedAt,revision:r.version,status:r.status});
export function createKnowledge({records,employee,files,conversations,projects}) {
  async function execute(actor,op,input) {
    const employeeId=input.employeeId ?? actor;
    if(actor!=='owner' && employeeId!==actor) fail(403,'Private employee memory.');
    if(input.projectId) {
      if(!projects) fail(503,'Projects unavailable.');
      await projects.execute(actor,'project.get',{projectId:input.projectId});
    } else if(employeeId==='owner' || !await employee(employeeId)) fail(404,'Select an employee.');
    const pk=input.projectId?'knowledge-project#'+input.projectId:'knowledge-employee#'+employeeId;
    if(op==='knowledge.list') {
      const limit=input.limit ?? 50;
      if(!Number.isInteger(limit)||limit<1||limit>100||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>240)) fail(400,'Invalid memory search.');
      const terms=(input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const page=await records.list(pk,{limit,after:input.after});
      const memories=page.items.filter(r=>r.status==='active').map(note).map(m=>({m,score:terms.filter(t=>m.text.toLowerCase().includes(t)).length}))
        .filter(({m,score})=>!terms.length||m.pinned||score).sort((a,b)=>Number(b.m.pinned)-Number(a.m.pinned)||b.score-a.score||b.m.updatedAt.localeCompare(a.m.updatedAt)).map(r=>r.m);
      return {memories,...(page.next&&{next:page.next})};
    }
    if(!['knowledge.save','knowledge.correct','knowledge.forget'].includes(op)) fail(404,'Unknown memory operation.');
    const id=fileRequest(input.requestId), create=op==='knowledge.save', forget=op==='knowledge.forget';
    const memoryId=create?digest([pk,actor,id]):input.memoryId;
    if(typeof memoryId!=='string'||!/^[a-f0-9]{64}$/.test(memoryId)) fail(400,'Invalid memory ID.');
    const receipt='knowledge-request#'+actor;
    const signature=digest([pk,op,memoryId,input.text ?? null,input.source ?? null,input.pinned ?? null,input.expectedVersion ?? null]);
    async function replay() {
      const row=await records.get(receipt,id);
      if(!row)return;
      if(row.signature!==signature) fail(409,'Memory requestId already used.');
      return {memoryId,revision:row.revision};
    }
    const done=await replay();if(done)return done;
    const old=await records.get(pk,memoryId);
    if(!create && (!old || old.status!=='active')) fail(404,'Active memory unavailable.');
    if(!create && input.projectId && actor!=='owner' && old.authorId!==actor) fail(403,'Only author or owner can edit this decision.');
    if(input.expectedVersion!==undefined && input.expectedVersion!==(old?.version ?? 0)) fail(409,'Memory revision has changed.');
    if(!forget && (typeof input.text!=='string'||!input.text.trim()||input.text.length>4000)) fail(400,'Invalid memory.');
    if(input.pinned!==undefined && typeof input.pinned!=='boolean')fail(400,'Invalid pin setting.');
    let source=old?.source ?? {type:'direct',authorId:actor};
    if(!forget && input.source) {
      const s=input.source;
      if(typeof s.path==='string' && Number.isSafeInteger(s.version)) {
        await files.execute(actor,'files.read',{path:s.path,version:s.version});
        source={path:s.path,version:s.version};
      } else if(typeof s.conversationId==='string'&&typeof s.messageId==='string'&&!input.projectId) {
        // Every source reader must already be a participant, including administrative writes.
        await conversations.execute(employeeId,'messages.get',{conversationId:s.conversationId,messageId:s.messageId});
        source={conversationId:s.conversationId,messageId:s.messageId};
      } else fail(400,'Invalid memory source.');
    }
    const now=new Date().toISOString(), revision=(old?.version ?? 0)+1;
    const next={employeeId:old?.employeeId ?? employeeId,...(input.projectId&&{projectId:input.projectId}),
      authorId:old?.authorId ?? actor,updatedBy:actor,createdAt:old?.createdAt ?? now,updatedAt:now,
      pinned:forget?false:input.pinned ?? old?.pinned ?? false,source:forget?null:source,text:forget?'':input.text.trim(),status:forget?'forgotten':'active'};
    if(await records.transact([{pk,sk:memoryId,expect:old?.version ?? null,value:next},
      {pk:receipt,sk:id,expect:null,value:{signature,revision}},...eventRows('knowledge.'+(forget?'forgotten':create?'saved':'corrected'),{actor,employeeId,projectId:input.projectId},id)])) return {memoryId,revision};
    return (await replay()) ?? fail(409,'Retry after refreshing the memory.');
  }
  return {execute};
}
