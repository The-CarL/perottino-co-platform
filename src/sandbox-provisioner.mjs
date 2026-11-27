import { SQSClient, CreateQueueCommand, DeleteQueueCommand, GetQueueUrlCommand, GetQueueAttributesCommand, ListQueueTagsCommand } from '@aws-sdk/client-sqs';
import { checkSpec,queueTemplate } from './company-infrastructure.mjs';

const slots=8, hour=3_600_000;
const absent=err=>['QueueDoesNotExist','AWS.SimpleQueueService.NonExistentQueue','NonExistentQueue'].includes(err?.name);
const fault=status=>Object.assign(new Error('Sandbox resource request declined.'),{status});

export function createQueueProvisioner({sqs,scope,account,region,provenance={},now=Date.now}) {
  if(!/^[a-f0-9-]{36}-[a-z0-9][a-z0-9-]{0,15}$/.test(scope)||!/^\d{12}$/.test(account)||
    !/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw fault(500);
  const pattern='factory-'+scope+'-r-q-';
  const name=i=>pattern+i;
  const expectedAttributes={SqsManagedSseEnabled:'true',MessageRetentionPeriod:'3600',MaximumMessageSize:'65536',VisibilityTimeout:'30'};
  const permittedTags=Object.fromEntries(Object.entries(provenance).filter(([k,v])=>k.startsWith('factory:') &&
    typeof v==='string' && v.length<=256));
  async function lookup(slot) {
    try {
      const {QueueUrl}=await sqs.send(new GetQueueUrlCommand({QueueName:name(slot),QueueOwnerAWSAccountId:account}));
      // Pin subsequent API calls to this region, account and physical slot.
      if(QueueUrl!=='https://sqs.'+region+'.amazonaws.com/'+account+'/'+name(slot)) throw fault(503);
      const {Tags}=await sqs.send(new ListQueueTagsCommand({QueueUrl}));
      return {url:QueueUrl,tags:Tags??{}};
    } catch(err){if(absent(err)) return null;throw err;}
  }
  const owned=t=>t['factory:s']===scope && t['perottino:purpose']===queueTemplate;
  const matches=(row,s)=>row && owned(row.tags) && row.tags['perottino:resource']===s.resourceId &&
    row.tags['perottino:project']===s.projectId && row.tags['perottino:expires']===s.expiresAt;
  async function checked(row) {
    const {Attributes}=await sqs.send(new GetQueueAttributesCommand({QueueUrl:row.url,AttributeNames:Object.keys(expectedAttributes)}));
    if(!Object.entries(expectedAttributes).every(([key,value])=>Attributes?.[key]===value)) throw fault(409);
    return {status:'active',url:row.url};
  }
  async function remove(row) {
    try {await sqs.send(new DeleteQueueCommand({QueueUrl:row.url}));} catch(err){if(!absent(err)) throw err;}
  }
  return {async execute(op,input) {
    const spec=checkSpec(input);
    const current=await lookup(spec.slot);
    if(op==='status') return matches(current,spec) ? checked(current):{status:'absent'};
    if(op==='remove') {
      if(matches(current,spec)) {
        await remove(current);
        if(matches(await lookup(spec.slot),spec)) return {status:'removing'};
      }
      return {status:'absent'};
    }
    if(op!=='provision') throw fault(400);
    if(Date.parse(spec.expiresAt)<=now() || Date.parse(spec.createdAt)>now()+60_000 || Date.parse(spec.expiresAt)>now()+168*hour) throw fault(409);
    if(current) {
      if(!matches(current,spec)) throw fault(409);
      return checked(current);
    }
    await sqs.send(new CreateQueueCommand({QueueName:name(spec.slot),Attributes:expectedAttributes,tags:{...permittedTags,'factory:s':scope,'perottino:purpose':queueTemplate,'perottino:resource':spec.resourceId,
      'perottino:project':spec.projectId,'perottino:expires':spec.expiresAt}}));
    const verified=await lookup(spec.slot);
    if(!matches(verified,spec)) throw fault(503);
    return checked(verified);
  },async sweep() {
    let expired=0;
    for(let i=0;i<slots;i++) {
      const row=await lookup(i);
      if(row && owned(row.tags) && /^i-[a-f0-9]{32}$/.test(row.tags['perottino:resource']) &&
        /^p-[a-f0-9]{32}$/.test(row.tags['perottino:project']) && Date.parse(row.tags['perottino:expires'])<=now()) {
        await remove(row); expired++;
      }
    }
    return {expired};
  }};
}

let instance;
export async function handler(event) {
  instance??=createQueueProvisioner({sqs:new SQSClient({}),scope:process.env.PEROTTINO_SCOPE,account:process.env.SANDBOX_ACCOUNT,
    region:process.env.AWS_REGION,provenance:JSON.parse(process.env.QUEUE_PROVENANCE || '{}')});
  // Fixed scheduled invocation is outside the API Gateway event envelope.
  if(event?.trigger==='sandbox-expiry' && !event.requestContext) return instance.sweep();
  try {
    if(event?.httpMethod!=='POST' || event?.path!=='/resources' || !event.requestContext?.identity?.userArn ||
      event.isBase64Encoded || typeof event.body!=='string' || event.body.length>2048) throw fault(400);
    const {operation,spec}=JSON.parse(event.body);
    return {statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify(await instance.execute(operation,spec))};
  } catch(err) {return {statusCode:err.status??503,body:'{"error":"sandbox_request_declined"}'};}
}
