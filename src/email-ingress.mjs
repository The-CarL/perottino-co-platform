import { timingSafeEqual } from 'node:crypto';
import PostalMime, { addressParser } from 'postal-mime';
import { createCloudStore } from './cloud-store.mjs';
import { makeDynamoRecords } from './foundation-records.mjs';
import { createCompanyMail, mailAddress, mailRoute, rfcId } from './company-mail.mjs';

const maxBytes = 150 * 1024;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const clean = (v,n) => typeof v==='string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ').trim().slice(0,n) : '';
const header = (mime,name) => mime.headers.filter(h=>h.key.toLowerCase()===name);
function address(v) { try {return mailAddress(v);}catch{return null;} }
function secretEqual(a,b) {
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}

export function createEmailIngress({store,mail,domain,topicArn,readOwnerIdentity}) {
  if(!domainPattern.test(domain??'')||!topicArn||!mail) throw new Error('Incomplete email configuration.');
  return async event=>{
    if(!Array.isArray(event?.Records)||!event.Records.length) throw new Error('Expected an SNS delivery.');
    let delivered=0,ignored=0;
    for(const record of event.Records) {
      if(record.EventSource!=='aws:sns'||record.Sns?.TopicArn!==topicArn) throw new Error('Unexpected mail event source.');
      if(record.Sns.Subject==='Amazon SES Setup Notification'){ignored++;continue;}
      const item=JSON.parse(record.Sns.Message),proof=item.receipt;
      if(item.notificationType!=='Received'||!Array.isArray(proof?.recipients)||!/^[-a-zA-Z0-9]{1,200}$/.test(item.mail?.messageId??''))
        throw new Error('Malformed receipt.');
      if(proof.virusVerdict?.status!=='PASS'||proof.spamVerdict?.status!=='PASS'){ignored++;continue;}
      if(typeof item.content!=='string'||!item.content.length||item.content.length>Math.ceil(maxBytes/3)*4) throw new Error('Invalid mail content size.');
      const raw=Buffer.from(item.content,'base64');
      if(raw.length>maxBytes||raw.toString('base64')!==item.content) throw new Error('Invalid mail encoding.');
      const mime=await PostalMime.parse(raw);
      const directory=await store.listEmployees();
      const fromLines=header(mime,'from');
      const mailboxes=fromLines.length===1 ? addressParser(fromLines[0].value) : [];
      const envelope=address(item.mail.source);
      const singleFrom=mailboxes.length===1 && !mailboxes[0].group ? address(mailboxes[0].address) : null;
      const dmarc=proof.dmarcVerdict?.status==='PASS' && proof.dkimVerdict?.status==='PASS';
      const from=(dmarc && singleFrom)||envelope;
      if(!from){ignored++;continue;}
      const authenticatedSender=dmarc && !!singleFrom || proof.spfVerdict?.status==='PASS'&&envelope===singleFrom;
      const auto=header(mime,'auto-submitted').some(h=>h.value.trim().toLowerCase()!=='no')||
        header(mime,'x-auto-response-suppress').length>0 || header(mime,'list-id').length>0 ||
        /^multipart\/report/i.test(header(mime,'content-type')[0]?.value??'');
      const recipients=new Map();
      for(const rawTo of proof.recipients) {
        if(typeof rawTo!=='string') continue;
        let to=rawTo.toLowerCase(),employee,trustedOwner=false;
        // The bearer alias is never copied into company mail records, model inputs or public From.
        // SES can lowercase recipients: use only lowercase base32 for newly provisioned owner capabilities.
        if(/^owner-[a-z2-7]{52}@/.test(to) && to.endsWith('@'+domain) && readOwnerIdentity && dmarc && singleFrom && !auto) {
          const identity=await readOwnerIdentity();
          if(identity && /^[a-z2-7]{52}$/.test(identity.token??'') && address(identity.address)===singleFrom &&
             secretEqual(to,'owner-'+identity.token+'@'+domain)) {
            employee=directory.find(p=>p.id==='ceo'&&p.desiredState!=='fired');
            if(employee){to=employee.handle+'@'+domain;trustedOwner=true;}
          }
        } else employee=mailRoute(to,domain,directory);
        if(employee && (!recipients.has(employee.id)||trustedOwner)) recipients.set(employee.id,{to,trustedOwner});
      }
      // Freeze alias ownership on first processing, including an unknown recipient. An SNS
      // retry after a promotion or hire must not deliver old correspondence to a new holder.
      const snapshot=[...recipients].map(([employeeId,route])=>({employeeId,...route}));
      const routes=mail.routesForReceipt ? await mail.routesForReceipt(item.mail.messageId,snapshot) : snapshot;
      if(!routes.length){ignored++;continue;}
      const refs=[...new Set([...header(mime,'references'),...header(mime,'in-reply-to')]
        .flatMap(h=>h.value.match(/<[^<>\s]{1,252}>/g)??[]).filter(v=>rfcId(v)&&!/owner-[a-z2-7]{52}/i.test(v)))].slice(-10);
      const messageId=header(mime,'message-id').length===1 && !/owner-[a-z2-7]{52}/i.test(mime.messageId??'') ? rfcId(mime.messageId) : null;
      const subject=clean(mime.subject,250).replace(/[\r\n]/g,' ')||'(no subject)';
      const text=clean(mime.text,12000)||'[Message has no plain-text part.]';
      for(const rcpt of routes) {
        // Suppress leaked capability aliases even when a client quotes the delivery address in the body.
        const scrub=s=>s.replace(/owner-[a-z2-7]{52}(?:@[-.a-z0-9]+)?/gi,'[private owner address]');
        try {
          await mail.receive({employeeId:rcpt.employeeId,to:rcpt.to,from,subject:scrub(subject),text:scrub(text),providerId:item.mail.messageId,
            rfcMessageId:messageId,references:refs,trustedOwner:rcpt.trustedOwner,canReply:!auto,allowThreading:Boolean(authenticatedSender),
            notify:!auto && Boolean(authenticatedSender)});
          delivered++;
        } catch(error){if(error.status!==410)throw error;ignored++;}
      }
    }
    return {delivered,ignored};
  };
}
let receive;
export async function handler(event) {
  if(!receive) {
    const {PEROTTINO_STATE_TABLE:tableName,PEROTTINO_MAIL_DOMAIN:domain,PEROTTINO_MAIL_TOPIC_ARN:topicArn,
      PEROTTINO_MAIL_OWNER_SECRET_ARN:ownerArn}=process.env;
    const store=createCloudStore({tableName,resident:true});
    const mail=createCompanyMail({records:makeDynamoRecords({tableName}),store,domain});
    let readOwnerIdentity;
    if(ownerArn) {
      const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
      const client=new SecretsManagerClient({});
      readOwnerIdentity=async()=>JSON.parse((await client.send(new GetSecretValueCommand({SecretId:ownerArn,VersionStage:'AWSCURRENT'}))).SecretString);
    }
    receive=createEmailIngress({store,mail,domain,topicArn,readOwnerIdentity});
  }
  return receive(event);
}
