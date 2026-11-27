import {createBrowserBudget} from './company-browser-budget.mjs';
import {makeAgentCoreBrowser} from './agentcore-browser.mjs';
import {join} from 'node:path';
import {localBlobs,s3Blobs} from './company-files.mjs';
import {createRemoteProjectGit} from './project-git.mjs';
import {createLocalProjectGit} from './project-git-local.mjs';
import {createLocalMailTransport} from './company-mail-outbox.mjs';
import {createRemoteInfrastructure,createLocalInfrastructure} from './company-infrastructure.mjs';
import {createDeployments,createDockerExecutor,createLambdaExecutor,startLocalDelivery} from './company-deployments.mjs';

function configuration(env) {
  const modelIds=(env.PEROTTINO_BEDROCK_MODELS ?? env.PEROTTINO_BEDROCK_MODEL ?? 'us.openai.gpt-6-sol').split(',');
  const profiles=JSON.parse(env.PEROTTINO_BROWSER_PROFILES ?? '[]');
  const tariffs=JSON.parse(env.PEROTTINO_MODEL_TARIFFS ?? '{}');
  return {modelIds,profiles,deliveryPolicy:JSON.parse(env.PEROTTINO_DELIVERY_POLICY ?? '{}'),meter:args=>({async execute(actor,op,input){
    const {makeModelMeter}=await import('./company-meter.mjs');
    return makeModelMeter({...args,tariffs}).execute(actor,op,input);
  }})};
}
function browserAdapter(config,makeProvider,region) {
  let provider;
  return args=>({async execute(actor,op,input) {
    const budget=config.browserMinutesPerMonth===undefined ? undefined :
      createBrowserBudget({records:args.records,minutes:config.browserMinutesPerMonth});
    if (budget && op==='browser.usage') {
      if (actor!=='owner') throw Object.assign(new Error('Owner access required.'),{status:403});
      return budget.usage();
    }
    if (budget && op==='browser.document') {
      // Only the broker's role can start a paid session under a configured allowance.
      const reader=makeAgentCoreBrowser({region,admit:()=>budget.reserve(actor,'document',input.requestId)});
      return reader(input.url);
    }
    const {createManagedBrowser}=await import('./company-browser.mjs');
    provider ??= Promise.resolve(makeProvider());
    try {return await createManagedBrowser({...args,budget,profiles:config.profiles,provider:await provider}).execute(actor,op,input);}
    catch(error){if(!await provider.catch(()=>null))provider=undefined;throw error;}
  }});
}
export function hostedAdapters(env=process.env) {
  const config=configuration(env);
  if(env.PEROTTINO_BROWSER_MONTHLY_MINUTES!==undefined) {
    if(!/^\d{1,7}$/.test(env.PEROTTINO_BROWSER_MONTHLY_MINUTES)) throw Error('Invalid monthly browser allowance.');
    config.browserMinutesPerMonth=Number(env.PEROTTINO_BROWSER_MONTHLY_MINUTES);
  }
  return {...config,infrastructure:env.PEROTTINO_SANDBOX_API_ORIGIN ? createRemoteInfrastructure({origin:env.PEROTTINO_SANDBOX_API_ORIGIN,region:env.PEROTTINO_SANDBOX_API_REGION}) : null,
    blobs:env.PEROTTINO_FILES_BUCKET && s3Blobs(env.PEROTTINO_FILES_BUCKET),
    git:createRemoteProjectGit({functionName:env.PEROTTINO_PROJECTS_GIT_ARN}),
    mail:{domain:env.PEROTTINO_MAIL_DOMAIN ?? 'company.invalid',externalEnabled:env.PEROTTINO_MAIL_OUTBOUND==='1'},
    browser:browserAdapter(config,async()=>{const {agentCoreInteractiveBrowser}=await import('./interactive-browser.mjs');
      return agentCoreInteractiveBrowser({deliveryOrigin:env.PEROTTINO_DELIVERY_ORIGIN,region:env.AWS_REGION,browserIdentifier:'aws.browser.v1'});},env.AWS_REGION),
    deployments:args=>createDeployments({...args,origin:env.PEROTTINO_DELIVERY_ORIGIN,policy:config.deliveryPolicy,execute:createLambdaExecutor(env.PEROTTINO_DELIVERY_EXECUTOR_ARN)})};
}

export function localAdapters({dataDir,records,env=process.env}) {
  const config=configuration(env);
  let listener;
  async function start() {
    const old=await records.get('local-runtime','preview');
    const port=Number(env.PEROTTINO_DELIVERY_PORT ?? old?.port ?? 0);
    const server=await startLocalDelivery({records,port});
    if(!old || old.port!==port) await records.transact([{pk:'local-runtime',sk:'preview',expect:old?.version ?? null,
      value:{port:Number(new URL(server.origin).port)}}]);
    return server;
  }
  const listen=()=>listener ??= start().catch(error=>{listener=undefined;throw error;});
  const executor=createDockerExecutor({image:env.PEROTTINO_DELIVERY_IMAGE || 'perottino-delivery:local'});
  const adapters={...config,infrastructure:createLocalInfrastructure({directory:join(dataDir,'sandbox-resources')}),blobs:localBlobs(join(dataDir,'corporate-files')),git:createLocalProjectGit({directory:join(dataDir,'projects.git')}),
    mail:{domain:env.PEROTTINO_MAIL_DOMAIN || 'company.invalid',externalEnabled:true},mailTransport:records=>createLocalMailTransport({records}),
    browser:browserAdapter(config,async()=>{const {localInteractiveBrowser}=await import('./interactive-browser.mjs');return localInteractiveBrowser({dataDir,deliveryOrigin:async()=>(await listen()).origin});}),
    deployments:args=>Object.fromEntries(['build','preview','release','rollback','status','withdraw','expire'].map(op=>[op,async(actor,input)=>{
      const {origin}=await listen();
      return createDeployments({...args,origin,policy:config.deliveryPolicy,execute:executor})[op](actor,input);
    }]))};
  return {adapters,listen,close:async()=>{if(listener)await (await listener).close();}};
}
