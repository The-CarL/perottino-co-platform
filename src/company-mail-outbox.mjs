import { mailActivity, mailRoute, mailRetry, mailValue, writeMail } from './company-mail.mjs';

const key=(at,id)=>String(at).padStart(13,'0')+'#'+id;
const confirmed={sent:1,delivered:2,failed:3,bounced:4,complained:5};
const rowFor=(m,value)=>writeMail(m.pk,m.sk,{...mailValue(m),...value},m.version);
const drop=r=>writeMail(r.pk,r.sk,null,r.version);
const providerId = s => typeof s==='string' && /^[a-zA-Z0-9_-]{1,200}$/.test(s);
const throttleErrors = new Set(['TooManyRequestsException','ThrottlingException']);
const rejectionErrors = new Set(['MessageRejected','BadRequestException','MailFromDomainNotVerifiedException',
  'AccountSuspendedException','SendingPausedException','AccessDeniedException','NotFoundException']);

function denialDetails(detail,message) {
  const lower=detail.toLowerCase();
  let target;
  if (lower.includes(':identity/'+message.to.toLowerCase())) target='recipientIdentity';
  else if (lower.includes(':identity/'+message.from.toLowerCase())) target='senderAddressIdentity';
  else if (lower.includes(':identity/'+message.from.split('@').at(-1).toLowerCase())) target='senderDomainIdentity';
  else if (lower.includes(':configuration-set/')) target='configurationSet';
  else if (lower.includes(':secret:')) target='secret';
  else if (lower.includes(':identity/')) target='otherIdentity';
  let policy;
  if (lower.includes('permissions boundary')) policy='permissionsBoundary';
  else if (lower.includes('identity-based policy')) policy='identityPolicy';
  else if (lower.includes('service control policy')) policy='serviceControlPolicy';
  else if (lower.includes('resource-based policy')) policy='resourcePolicy';
  const operation=['ses:SendEmail','ses:SendRawEmail','secretsmanager:GetSecretValue','kms:Decrypt']
    .find(op=>lower.includes(op.toLowerCase()));
  return {...(target && {target}),...(policy && {policy}),...(operation && {operation})};
}

function deliveryError(error,message) {
  const code = throttleErrors.has(error.name) || rejectionErrors.has(error.name) ? error.name : 'UnknownProviderError';
  const detail = String(error.message ?? '');
  let cause;
  if (/not verified|not been verified/i.test(detail)) cause='unverifiedIdentity';
  else if (/not authorized|explicit deny|access denied/i.test(detail)) cause='permissionDenied';
  else if (/header/i.test(detail)) cause='invalidHeader';
  else if (/email address|mailbox|local part/i.test(detail)) cause='invalidAddress';
  const requestId=error.$metadata?.requestId;
  return {code,...(cause && {cause}),...(cause==='permissionDenied' && denialDetails(detail,message)),
    ...(/^[0-9a-f-]{36}$/i.test(requestId ?? '') && {requestId})};
}

export function createLocalMailTransport({records}) {
  return {localCapture:true,async send(message) {
    const id='capture-'+message.id;
    const copy={from:message.from,to:message.to,subject:message.subject,text:message.text,references:message.references,inReplyTo:message.inReplyTo};
    if(!await records.get('mail-capture',id)) await records.transact([writeMail('mail-capture',id,copy)]);
    return {providerId:id};
  }};
}

export async function recordMailReceipt({records,id,provider,status,from,to,at=Date.now()}) {
  if(!providerId(provider)||!/^[a-f0-9]{64}$/.test(id??'')||!Object.hasOwn(confirmed,status)) return false;
  return mailRetry(async()=>{
    const m=await records.get('mail-messages',id);
    if(!m||m.direction!=='outbound'||m.from!==from||m.to!==to||m.providerId && m.providerId!==provider) return false;
    // SES events can arrive before SendEmail returns. Only an issued intent may be reconciled.
    if(!['sending','uncertain',...Object.keys(confirmed)].includes(m.status)) return false;
    if((confirmed[m.status]??0)>=confirmed[status] && m.providerId===provider) return true;
    const mapping=await records.get('mail-provider',provider);
    if(mapping && mapping.messageId!==id) return false;
    const changes=[rowFor(m,{status,deliveryError:null,providerId:provider,providerAt:new Date(at).toISOString()})];
    if(m.status!==status) changes.push(...mailActivity('mail.status',m,'mail-sender',m.sender,status));
    if(!mapping) changes.push(writeMail('mail-provider',provider,{threadId:m.threadId,messageId:id}));
    if(m.attemptKey) {
      const attempt=await records.get('mail-attempts',m.attemptKey);
      if(attempt) changes.push(drop(attempt));
    }
    if(await records.transact(changes)) return true;
  });
}

async function finishAttempt(records,id,kind,now,diagnostic) {
  return mailRetry(async()=>{
    const m=await records.get('mail-messages',id);
    if(m?.status!=='sending') return true;
    const attempt=await records.get('mail-attempts',m.attemptKey);
    if(!attempt) return false;
    const retry=kind==='throttled' && m.attempts<4;
    const status=retry?'queued':kind==='uncertain'?'uncertain':'failed';
    const changes=[drop(attempt),rowFor(m,{status,deliveryError:diagnostic??null}),
      ...mailActivity('mail.status',m,'mail-sender',m.sender,status,diagnostic?.cause??diagnostic?.code)];
    if(retry) {
      const due=now()+60_000*(2**(m.attempts-1));
      changes.push(writeMail('mail-outbox',key(due,id),{id,attempts:m.attempts,at:due}));
    }
    if(await records.transact(changes)) return true;
  });
}

export async function dispatchCompanyMail({records,store,domain,transport,now=Date.now,claimRecordsFor}) {
  const {items:[stale]}=await records.list('mail-attempts',{limit:1});
  if(stale && stale.deadline<=now()) await finishAttempt(records,stale.id,'uncertain',now);
  const {items:[q]}=await records.list('mail-outbox',{limit:1});
  if(!q || q.at>now()) return false;
  const m=await records.get('mail-messages',q.id);
  if(!m||m.status!=='queued') {await records.transact([drop(q)]);return true;}
  const person=await store.employee(m.sender);
  if(!person||person.desiredState==='fired') {
    await records.transact([drop(q),rowFor(m,{status:'failed'}),...mailActivity('mail.status',m,'mail-sender',m.sender,'failed')]);
    return true;
  }
  if(person.desiredState!=='active') {
    const at=now()+60000;
    await records.transact([drop(q),writeMail('mail-outbox',key(at,m.id),{...mailValue(q),at})]);return true;
  }
  if(transport.isReady && !await transport.isReady()) return false;
  // A reassigned office alias must never send on behalf of its previous holder.
  const directory=await store.listEmployees();
  const from=mailRoute(m.from,domain,directory)?.id===person.id ? m.from : person.handle+'@'+domain;
  const deadline=now()+300000,attemptKey=key(deadline,m.id);
  const claimed={...mailValue(m),from,status:'sending',attempts:q.attempts+1,attemptKey};
  const guarded=claimRecordsFor?claimRecordsFor(person):records;
  let acquired;
  try { acquired=await guarded.transact([drop(q),writeMail(m.pk,m.sk,claimed,m.version),
    writeMail('mail-attempts',attemptKey,{id:m.id,deadline}),
    ...mailActivity('mail.dispatched',claimed,'mail-sender',m.sender,'sending')]); }
  catch(error){if(error.code==='FOUNDATION_GUARD_DENIED') return false;throw error;}
  if(!acquired) return true;
  let result;
  try { result=await transport.send(claimed); }
  catch(error) {
    // Only explicit provider rejection permits a new transmission. A timeout, crash or 5xx
    // can follow provider acceptance; keep the intent for tagged event reconciliation.
    const diagnostic=deliveryError(error,claimed);
    const reason=throttleErrors.has(diagnostic.code)?'throttled':rejectionErrors.has(diagnostic.code)?'failed':'uncertain';
    await finishAttempt(records,m.id,reason,now,diagnostic);return true;
  }
  if(!providerId(result?.providerId)) {await finishAttempt(records,m.id,'uncertain',now);return true;}
  await recordMailReceipt({records,id:m.id,from,to:m.to,provider:result.providerId,status:'sent',at:now()});
  return true;
}
