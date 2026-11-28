import { makeDynamoRecords } from './foundation-records.mjs';
import { createCloudStore } from './cloud-store.mjs';
import { dispatchCompanyMail, recordMailReceipt } from './company-mail-outbox.mjs';

export function createSesMailTransport({client,GetEmailIdentityCommand,SendEmailCommand,configurationSet,identityArn,readOwnerIdentity,domain,now=Date.now}) {
  if(!configurationSet) throw new Error('Mail configuration set required.');
  let verified=false,checkAfter=0;
  async function isReady() {
    if(now()<checkAfter) return verified;
    try {
      const identity=await client.send(new GetEmailIdentityCommand({EmailIdentity:domain}),
        {abortSignal:AbortSignal.timeout(5000)});
      verified=identity.VerifiedForSendingStatus===true;
    } catch {
      verified=false;
    }
    checkAfter=now()+30_000;
    return verified;
  }
  return {isReady,async send(m) {
    const headers=[];
    if(m.inReplyTo) headers.push({Name:'In-Reply-To',Value:m.inReplyTo});
    const references=[...m.references];
    while(references.join(' ').length>850) references.shift();
    if(references.length) headers.push({Name:'References',Value:references.join(' ')});
    // Auto-Submitted prevents mail responders from repeatedly answering a company-generated reply.
    if(m.inReplyTo) headers.push({Name:'Auto-Submitted',Value:'auto-replied'});
    let replyTo;
    if(m.ownerReplyRoute && readOwnerIdentity) {
      const identity=await readOwnerIdentity();
      if(identity?.address?.toLowerCase()===m.to && /^[a-z2-7]{52}$/.test(identity.token??''))
        replyTo='owner-'+identity.token+'@'+domain;
    }
    const response=await client.send(new SendEmailCommand({FromEmailAddress:m.from,
      ...(identityArn && {FromEmailAddressIdentityArn:identityArn}),Destination:{ToAddresses:[m.to]},
      ...(replyTo&&{ReplyToAddresses:[replyTo]}),ConfigurationSetName:configurationSet,EmailTags:[{Name:'company-mail-id',Value:m.id}],Content:{Simple:{
        Subject:{Data:m.subject,Charset:'UTF-8'},Body:{Text:{Data:m.text,Charset:'UTF-8'}},Headers:headers}}}),
      {abortSignal:AbortSignal.timeout(10000)});
    return {providerId:response.MessageId};
  }};
}

export function createMailSender({records,store,transport,domain,topicArn,configurationSet,claimRecordsFor}) {
  return async event=>{
    if(event?.operation==='dispatch' && !event.Records) {
      // EventBridge invokes this role-isolated function with a fixed payload once per minute.
      for(let i=0;i<10;i++) if(!await dispatchCompanyMail({records,store,transport,domain,claimRecordsFor})) break;
      return {ok:true};
    }
    if(!Array.isArray(event?.Records)||!event.Records.length) throw new Error('Unexpected outbound mail event.');
    for(const record of event.Records) {
      if(record.EventSource!=='aws:sns'||record.Sns?.TopicArn!==topicArn) throw new Error('Unexpected mail receipt source.');
      const item=JSON.parse(record.Sns.Message);
      const statuses={Send:'sent',Delivery:'delivered',Bounce:'bounced',Complaint:'complained',Reject:'failed',RenderingFailure:'failed','Rendering Failure':'failed'};
      const status=statuses[item.eventType];
      if(!status||item.mail?.tags?.['ses:configuration-set']?.[0]!==configurationSet) continue;
      await recordMailReceipt({records,id:item.mail.tags['company-mail-id']?.[0],provider:item.mail.messageId,
        from:item.mail.source?.toLowerCase(),to:item.mail.destination?.length===1?item.mail.destination[0].toLowerCase():null,status});
    }
    return {ok:true};
  };
}
let run;
export async function handler(event) {
  if(!run) {
    const {SESv2Client,GetEmailIdentityCommand,SendEmailCommand}=await import('@aws-sdk/client-sesv2');
    const tableName=process.env.PEROTTINO_STATE_TABLE,domain=process.env.PEROTTINO_MAIL_DOMAIN,configurationSet=process.env.PEROTTINO_MAIL_CONFIGURATION_SET;
    const records=makeDynamoRecords({tableName}),store=createCloudStore({tableName,resident:true});
    const secret=process.env.PEROTTINO_MAIL_OWNER_SECRET_ARN;
    let readOwnerIdentity;
    if(secret) {
      const {SecretsManagerClient,GetSecretValueCommand}=await import('@aws-sdk/client-secrets-manager');
      const client=new SecretsManagerClient({});
      readOwnerIdentity=async()=>JSON.parse((await client.send(new GetSecretValueCommand({SecretId:secret,VersionStage:'AWSCURRENT'}))).SecretString);
    }
    const transport=createSesMailTransport({domain,identityArn:process.env.PEROTTINO_MAIL_IDENTITY_ARN,readOwnerIdentity,
      client:new SESv2Client({maxAttempts:1}),GetEmailIdentityCommand,SendEmailCommand,configurationSet});
    const scoped=new Map();
    function claimRecordsFor(person) {
      // Guard at the transition immediately preceding the external call.
      const label=person.id+'/'+person.generation;
      if(!scoped.has(label)) {
        if(scoped.size>=100){for(const r of scoped.values()) r.close();scoped.clear();}
        scoped.set(label,makeDynamoRecords({tableName,conditions:[
          {ConditionCheck:{Key:{pk:'COMPANY#GATE',sk:'STATE'},ConditionExpression:'running=:on',ExpressionAttributeValues:{':on':true}}},
          {ConditionCheck:{Key:{pk:'DIRECTORY',sk:'AGENT#'+person.id},ConditionExpression:'desiredState=:active AND generation=:g',
            ExpressionAttributeValues:{':active':'active',':g':person.generation}}}
        ]}));
      }
      return scoped.get(label);
    }
    run=createMailSender({records,store,transport,domain,configurationSet,topicArn:process.env.PEROTTINO_MAIL_EVENTS_TOPIC_ARN,claimRecordsFor});
  }
  return run(event);
}
