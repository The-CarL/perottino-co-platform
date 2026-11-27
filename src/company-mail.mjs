import { createHash, randomUUID } from 'node:crypto';
import { eventRows } from './company-events.mjs';

export const mailHash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const failMail = (status, message) => Object.assign(new Error(message), { status });
export const mailValue = row => { const { pk, sk, version, ...data } = row; return data; };
export const writeMail = (pk, sk, value, expect = null) => ({ pk, sk, value, expect });
export function mailActivity(kind,message,actor,employeeId,status) {
  return eventRows(kind,{actor,employeeId,threadId:message.threadId,messageId:message.id,status},
    [message.id,message.attempts??0,status].join('/'));
}
const keyPattern = /^[a-f0-9]{64}$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const padded = n => String(n).padStart(13,'0');
const receipt = (threadId, messageId, status) => ({ threadId, messageId, status });
function requireText(value, max, header = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed() ||
      (header ? /[\x00-\x1f\x7f]/ : /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/).test(value)) throw failMail(400,'Invalid mail text.');
  return value.trim();
}
export function mailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim()) throw failMail(400,'Invalid mail address.');
  const [local,domain,...rest] = value.toLowerCase().split('@');
  if (rest.length || !domainPattern.test(domain) || local.length>64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local))
    throw failMail(400,'Invalid mail address.');
  return local+'@'+domain;
}
export function mailRoute(address,domain,people) {
  if (typeof address !== 'string' || !address.toLowerCase().endsWith('@'+domain)) return null;
  const at=address.toLowerCase().split('@');
  if(at.length!==2) return null;
  const members=people.filter(p=>p.desiredState!=='fired');
  const named=members.find(p=>at[0]==='ceo' ? p.id==='ceo' : p.handle===at[0]);
  if(named) return named;
  const roles=members.filter(p=>p.role.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')===at[0]);
  return roles.length===1 ? roles[0] : null;
}
export function rfcId(value) {
  return typeof value==='string' && value.length<=255 && /^<[!-~]+@[a-z0-9.-]+>$/i.test(value) &&
    !/[<>()\s]/.test(value.slice(1,-1)) ? value : null;
}
const publicThread = t => ({ id:t.id, subject:t.subject, members:t.members, contact:t.contact, createdAt:t.createdAt, updatedAt:t.updatedAt });
function publicMessage(m) {
  const {id,subject,from,to,text,createdAt,direction,status,inReplyTo,trustedOwner}=m;
  return {id,subject,from,to,text,createdAt,direction,status,inReplyTo,trustedOwner:Boolean(trustedOwner)};
}
function options(input) {
  const {limit=35,after}=input;
  if(!Number.isInteger(limit)||limit<1||limit>100||after!==undefined && (typeof after!=='string'||after.length>100||!/^\d{13}#[a-f0-9]{64}$/.test(after)))
    throw failMail(400,'Invalid mail cursor.');
  return {limit,...(after && {after})};
}
function requestKey(id) {
  if(typeof id!=='string'||!/^[-a-zA-Z0-9._:]{1,160}$/.test(id)) throw failMail(400,'Supply a unique mail request ID.');
  return id;
}
export async function mailRetry(fn) {
  for(let i=0;i<12;i++) {
    const result=await fn();
    if(result!==undefined) return result;
  }
  throw failMail(503,'Mail changed concurrently. Retry the same request.');
}

export function createCompanyMail({records,store,domain='company.invalid',externalEnabled=false,transport,now=Date.now}) {
  if(!domainPattern.test(domain)) throw new TypeError('Invalid company mail domain.');
  const outbound=transport?.localCapture ? 'capture' : externalEnabled ? 'ses' : 'disabled';
  const people=()=>store.listEmployees ? store.listEmployees() : store.directory();
  const folder=id=>'mail-folder#'+id;
  async function threadFor(actor,id) {
    if(!keyPattern.test(id??'')) throw failMail(404,'Mail thread not found.');
    const row=await records.get('mail-threads',id);
    if(!row || actor!=='owner' && !row.members.includes(actor)) throw failMail(404,'Mail thread not found.');
    return row;
  }
  async function matchedThread(contact,employeeId,references) {
    for(const ref of [...references].reverse()) {
      let link=await records.get('mail-references',mailHash(employeeId,contact,ref));
      if(!link && /@(?:[a-z0-9-]+\.)*amazonses\.com>$/i.test(ref))
        link=await records.get('mail-provider',ref.slice(1,ref.indexOf('@')));
      if(!link) continue;
      const thread=await records.get('mail-threads',link.threadId);
      if(thread?.contact===contact && thread.members.includes(employeeId)) return {threadId:thread.id,anchor:link.messageId};
    }
    return {};
  }
  async function append(args, completion) {
    const {id,requestHash,sender,recipient,to,from,subject,text,direction,contact,members}=args;
    return mailRetry(async()=>{
      const old=await records.get('mail-messages',id);
      if(old) {
        if(old.requestHash!==requestHash) throw failMail(409,'Mail request ID belongs to another message.');
        return receipt(old.threadId,old.id,old.status);
      }
      const when=now(),at=new Date(when).toISOString();
      const threadId=args.threadId??mailHash('thread',id);
      const current=await records.get('mail-threads',threadId);
      if(args.threadId && !current) throw failMail(404,'Mail thread not found.');
      const seq=(current?.seq??0)+1;
      const sk=padded(seq)+'#'+id;
      // Sequence is monotonic even if several messages arrive in the same millisecond.
      const updated=Math.max(when,(current?.updatedMs??0)+1);
      const index=padded(9999999999999-updated)+'#'+threadId;
      const thread={id:threadId,members,contact,subject:current?.subject??subject,seq,index,updatedMs:updated,
        createdAt:current?.createdAt??at,updatedAt:new Date(updated).toISOString()};
      const status=direction==='outbound'?'queued':direction==='inbound'?'received':'delivered';
      const msg={id,threadId,requestHash,seq,from,to,sender:sender??null,recipient:recipient??null,subject,text,direction,status,createdAt:at,
        inReplyTo:args.inReplyTo??null,references:args.references??[],rfcMessageId:args.rfcMessageId??null,
        trustedOwner:Boolean(args.trustedOwner),ownerReplyRoute:Boolean(args.ownerReplyRoute),canReply:args.canReply!==false};
      const changes=[writeMail('mail-messages',id,msg),writeMail('mail-threads',threadId,thread,current?.version??null),
        writeMail('mail-thread#'+threadId,sk,{id}),
        ...mailActivity(direction==='outbound'?'mail.queued':'mail.received',msg,args.actor,recipient??sender,status)];
      for(const member of [...members,'owner']) {
        if(current) {
          const prior=await records.get(folder(member),current.index);
          if(!prior) return;
          changes.push(writeMail(folder(member),prior.sk,null,prior.version));
        }
        changes.push(writeMail(folder(member),index,{threadId}));
      }
      if(direction==='outbound') changes.push(writeMail('mail-outbox',padded(when)+'#'+id,{id,attempts:0,at:when}));
      if(recipient && args.notify!==false) {
        const deliveryId=padded(when)+'#'+id;
        changes.push(writeMail('mail-inbox#'+recipient,deliveryId,{id:deliveryId,messageId:id,attempts:0}));
      }
      if(direction==='inbound' && msg.rfcMessageId && args.allowThreading!==false) {
        const rk=mailHash(recipient,contact,msg.rfcMessageId);
        const link=await records.get('mail-references',rk);
        if(!link) changes.push(writeMail('mail-references',rk,{threadId,messageId:id}));
      }
      if(completion) changes.push(...completion.changes);
      if(completion?.expiresAt<=now()) throw failMail(409,'Mail delivery lease expired.');
      if(await records.transact(changes)) return receipt(threadId,id,status);
    });
  }
  async function receive(input) {
    const employee=await store.employee(input.employeeId);
    const from=mailAddress(input.from),to=mailAddress(input.to);
    if(!employee || employee.desiredState==='fired') throw failMail(410,'Recipient is unavailable.');
    if(mailRoute(to,domain,await people())?.id!==employee.id) {
      const frozen=await records.get('mail-routing',input.providerId);
      if(!frozen?.routes.some(r=>r.employeeId===employee.id && r.to===to))
        throw failMail(410,'Recipient is unavailable.');
    }
    const refs=input.allowThreading===false ? [] : (input.references??[]).filter(rfcId).slice(-10);
    const linked=await matchedThread(from,employee.id,refs);
    const id=mailHash('received',employee.id,input.providerId);
    const text=requireText(input.text,16000),subject=requireText(input.subject||'(no subject)',250,true);
    return append({id,actor:input.trustedOwner===true?'owner':'external',requestHash:mailHash(input.providerId,employee.id,from,subject,text),...linked,from,to,subject,text,members:[employee.id],
      recipient:employee.id,direction:'inbound',contact:from,rfcMessageId:rfcId(input.rfcMessageId),inReplyTo:refs.at(-1),references:refs,
      trustedOwner:input.trustedOwner===true,allowThreading:input.allowThreading!==false,canReply:input.canReply!==false,notify:input.notify!==false});
  }
  async function send(actor,op,input,completion) {
    const employeeId=actor==='owner'?input.employeeId:actor;
    if(actor!=='owner' && input.employeeId!==undefined && input.employeeId!==actor) throw failMail(403,'Sender impersonation is forbidden.');
    const user=await store.employee(employeeId);
    if(!user||user.desiredState!=='active') throw failMail(403,'Active employee required for sending mail.');
    const id=mailHash('sent',actor,employeeId,requestKey(input.requestId));
    const text=requireText(input.text,16000),reply=op==='mail.reply';
    let target,subject,thread,from=user.handle+'@'+domain,refs=[],anchor;
    if(reply) {
      thread=await threadFor(employeeId,input.threadId);
      if(!keyPattern.test(input.messageId??'')) throw failMail(404,'Mail message not found.');
      anchor=await records.get('mail-messages',input.messageId);
      if(!anchor||anchor.threadId!==thread.id) throw failMail(404,'Mail message not found.');
      if(anchor.direction==='inbound'&&!anchor.canReply) throw failMail(403,'This automated message does not accept replies.');
      if(input.to!==undefined || input.from!==undefined) throw failMail(400,'Replies use the original correspondents.');
      target=thread.contact ?? (anchor.sender===employeeId?anchor.to:anchor.from);
      if(anchor.recipient===employeeId && mailRoute(anchor.to,domain,await people())?.id===employeeId) from=anchor.to;
      subject=/^re:/i.test(thread.subject)?thread.subject:'Re: '+thread.subject;
      const wire=anchor.rfcMessageId || (anchor.providerId ? '<'+anchor.providerId+'@email.amazonses.com>' : null);
      refs=[...new Set([...anchor.references,...(wire?[wire]:[])])].slice(-10);
    } else {
      if(input.from!==undefined) throw failMail(400,'From is derived from the employee directory.');
      target=mailAddress(input.to);subject=requireText(input.subject,250,true);
    }
    const internal=target.endsWith('@'+domain);
    const peer=internal?mailRoute(target,domain,await people()):null;
    if(internal&&(!peer||peer.id===employeeId||thread && !thread.members.includes(peer.id))) throw failMail(404,'Company recipient is unavailable.');
    if(!internal && outbound==='disabled') throw failMail(503,'External mail is disabled.');
    const result=await append({id,actor,requestHash:mailHash(op,input.to??null,input.threadId??null,input.messageId??null,subject,text),
      threadId:thread?.id,from,to:target,subject,text,members:peer?[employeeId,peer.id].sort():[employeeId],
      sender:employeeId,recipient:peer?.id,direction:peer?'internal':'outbound',contact:peer?null:target,references:refs,inReplyTo:refs.at(-1),
      notify:!completion,ownerReplyRoute:!peer && employeeId==='ceo' && (anchor?.trustedOwner || anchor?.ownerReplyRoute),rfcMessageId:peer?'<'+id+'@'+domain+'>':null},completion);
    if(!peer && transport?.localCapture) {
      const {dispatchCompanyMail}=await import('./company-mail-outbox.mjs');
      await dispatchCompanyMail({records,store,domain,transport,now});
    }
    return result;
  }
  async function work(actor,op,input) {
    if(actor==='owner') throw failMail(403,'Employee mail delivery requires a worker.');
    const pk='mail-inbox#'+actor;
    if(op==='mail.claim') {
      const lease=input.leaseMs??150000;
      if(!Number.isInteger(lease)||lease<1000||lease>300000) throw failMail(400,'Invalid mail lease.');
      return mailRetry(async()=>{
        const {items:[d]}=await records.list(pk,{limit:1});
        if(!d || d.until>now()) return {delivery:null};
        const msg=await records.get('mail-messages',d.messageId);
        if(!msg||msg.recipient!==actor) throw failMail(409,'Inconsistent mail delivery.');
        if(d.attempts>=3) {
          if(await records.transact([writeMail(pk,d.sk,null,d.version),writeMail('mail-failed#'+actor,d.sk,{messageId:msg.id})])) return {delivery:null};
          return;
        }
        const token=randomUUID(),expires=now()+lease;
        if(await records.transact([writeMail(pk,d.sk,{...mailValue(d),until:expires,token,attempts:d.attempts+1},d.version)]))
          return {delivery:{id:d.sk,token,threadId:msg.threadId,messageId:msg.id,from:msg.from,to:msg.to,subject:msg.subject,text:msg.text,
            senderId:msg.sender,external:msg.direction==='inbound',trustedOwner:msg.trustedOwner,canReply:msg.canReply && (msg.direction!=='inbound'||outbound!=='disabled')}};
      });
    }
    const d=await records.get(pk,input.deliveryId);
    if(!d) {
      const prior=await records.get('mail-finished#'+actor,input.deliveryId);
      if(prior?.token===input.token) return {ok:true};
      throw failMail(409,'Mail delivery lease is no longer current.');
    }
    if(typeof input.token!=='string'||input.token!==d.token||d.until<=now()) throw failMail(409,'Mail delivery lease is no longer current.');
    if(op==='mail.release') {
      const ok=await records.transact([writeMail(pk,d.sk,{id:d.id,messageId:d.messageId,attempts:d.attempts},d.version)]);
      if(!ok) throw failMail(409,'Mail delivery lease changed.');
      return {ok:true};
    }
    const done=[writeMail(pk,d.sk,null,d.version),writeMail('mail-finished#'+actor,d.sk,{token:d.token})];
    if(input.replyText!==undefined) {
      const msg=await records.get('mail-messages',d.messageId);
      const result=await send(actor,'mail.reply',{threadId:msg.threadId,messageId:msg.id,text:input.replyText,requestId:'inbox-'+msg.id},{changes:done,expiresAt:d.until});
      return {ok:true,...result};
    }
    if(!await records.transact(done)) throw failMail(409,'Mail delivery lease changed.');
    return {ok:true};
  }
  async function canUseSource(actor,source) {
    try {
      const thread=await threadFor(actor,source.threadId);
      const m=await records.get('mail-messages',source.messageId);
      return Boolean(m && m.threadId===thread.id && m.direction==='inbound' && m.trustedOwner && (actor==='owner' || m.recipient===actor));
    } catch(error) { if(error.status===404) return false;throw error; }
  }
  async function routesForReceipt(id,routes) {
    if(!/^[a-zA-Z0-9-]{1,200}$/.test(id)) throw failMail(400,'Invalid SES receipt ID.');
    return mailRetry(async()=>{
      const row=await records.get('mail-routing',id);
      if(row) return row.routes;
      if(await records.transact([writeMail('mail-routing',id,{routes})])) return routes;
    });
  }
  async function ownerRead(kind,ids) {
    if(!await records.transact(eventRows(kind,{actor:'owner',...ids},randomUUID())))
      throw failMail(503,'Could not record administrative mail access.');
  }
  return {receive,routesForReceipt,canUseSource,async execute(actor,op,input={}) {
    if(op==='mail.list') {
      const employeeId=actor==='owner'?(input.employeeId??'owner'):actor;
      if(actor!=='owner'&&input.employeeId!==undefined&&input.employeeId!==actor) throw failMail(403,'Private employee mailbox.');
      const opts=options(input);
      if(actor==='owner') {
        if(employeeId!=='owner' && !await store.employee(employeeId)) throw failMail(404,'Employee mailbox not found.');
        await ownerRead('admin.mail.folders.read',employeeId==='owner'?{}:{employeeId});
      }
      const page=await records.list(folder(employeeId),opts);
      const threads=await Promise.all(page.items.map(i=>threadFor(actor,i.threadId)));
      return {domain,outbound,threads:threads.map(publicThread),...(page.next&&{next:page.next})};
    }
    if(op==='mail.get') {
      const thread=await threadFor(actor,input.threadId);
      const opts=options(input);
      if(input.throughMessageId!==undefined) {
        if(input.after!==undefined||!keyPattern.test(input.throughMessageId)) throw failMail(400,'Invalid mail history anchor.');
        const anchor=await records.get('mail-messages',input.throughMessageId);
        if(!anchor||anchor.threadId!==thread.id) throw failMail(404,'Mail history anchor not found.');
        if(anchor.seq>opts.limit) opts.after=padded(anchor.seq-opts.limit)+'#'+'f'.repeat(64);
        opts.limit=Math.min(opts.limit,anchor.seq);
      }
      if(actor==='owner') await ownerRead('admin.mail.thread.read',{threadId:thread.id});
      const page=await records.list('mail-thread#'+thread.id,opts);
      const messages=await Promise.all(page.items.map(i=>records.get('mail-messages',i.id)));
      return {domain,outbound,thread:publicThread(thread),messages:messages.map(publicMessage),...(page.next&&!input.throughMessageId&&{next:page.next})};
    }
    if(['mail.send','mail.reply'].includes(op)) return send(actor,op,input);
    if(['mail.claim','mail.finish','mail.release'].includes(op)) return work(actor,op,input);
    throw failMail(404,'Unknown mail operation.');
  }};
}
