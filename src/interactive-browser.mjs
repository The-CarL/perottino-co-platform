import {browserSessionSeconds} from './company-browser-budget.mjs';
import {mkdtemp,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {browserControl} from './agentcore-browser.mjs';
import {spanAttributes} from './telemetry.mjs';
import {interactiveResource,validatePublicPage} from './browser.mjs';

const viewport={width:1280,height:800};
function deliveryPage(raw,deliveryOrigin) {
  if(!deliveryOrigin)return false;
  const url=new URL(raw);
  return url.origin===deliveryOrigin && /^\/(?:p\/p-[a-f0-9]{32}|v\/p-[a-f0-9]{32}\/b-[a-f0-9]{32})\/(?:[a-z\d_.-]+\/)*[a-z\d_.-]*$/i.test(url.pathname);
}
const check=(raw,origins,fixtureOrigin,deliveryOrigin)=>validatePublicPage(raw,{origins,
  fixtureOrigin:!origins&&deliveryPage(raw,deliveryOrigin)?deliveryOrigin:fixtureOrigin});
const configured=async value=>typeof value==='function'?value():value;


async function operate(context,op,input,{origins,fixtureOrigin,deliveryOrigin}={}) {
  const signal=AbortSignal.timeout(12_000);
  let count=0,bytes=0;
  async function guard(route) {
    try {
      const req=route.request();
      if(++count>65||bytes>5*1024*1024)throw new Error('Too many page requests.');
      const site=!origins&&deliveryPage(req.url(),deliveryOrigin);
      const response=await interactiveResource({raw:req.url(),method:req.method(),headers:await req.allHeaders(),
        body:req.postDataBuffer(),origins,fixtureOrigin:site?deliveryOrigin:fixtureOrigin,signal,site});
      bytes+=response.body.length;
      if(bytes>5*1024*1024)throw new Error('Page too large.');
      await route.fulfill(response);
    }catch{await route.abort().catch(()=>{});}
  }
  const pages=context.pages();
  const page=pages[0]??await context.newPage();
  const dismiss=dialog=>{void dialog.dismiss().catch(()=>{});};
  const popup=other=>{if(other!==page)void other.close().catch(()=>{});};
  page.on('dialog',dismiss);
  context.on('page',popup);
  await context.route('**/*',guard);
  try {
    await page.setViewportSize(viewport);
    if(page.url()!=='about:blank')await check(page.url(),origins,fixtureOrigin,deliveryOrigin);
    if(op==='browser.navigate') {
      await check(input.url,origins,fixtureOrigin,deliveryOrigin);
      await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:10_000});
    } else if(op==='browser.download') {
      await check(input.url,origins,fixtureOrigin,deliveryOrigin);
      const cookies=origins?await context.cookies(input.url):[];
      const response=await interactiveResource({raw:input.url,method:'GET',origins,fixtureOrigin:!origins&&deliveryPage(input.url,deliveryOrigin)?deliveryOrigin:fixtureOrigin,
        headers:{cookie:cookies.map(c=>c.name+'='+c.value).join('; ')},signal});
      if(response.status!==200 || response.body.length>60*1024 || !/^(application\/(json|pdf)|text\/(plain|csv)|image\/(png|jpeg))(?:;|$)/i.test(response.headers['content-type']))
        throw Object.assign(new Error('Unsupported browser import or size.'),{status:400});
      return {contentBase64:response.body.toString('base64')};
    } else if(op==='browser.frame'||op==='browser.screenshot') {
      const data=await page.screenshot({type:'jpeg',quality:50,timeout:5000});
      if(op==='browser.screenshot')return {contentBase64:data.toString('base64')};
      if(data.length>512*1024)throw new Error('Frame too large.');
      return {dataUrl:'data:image/jpeg;base64,'+data.toString('base64'),...viewport};
    } else if(op==='browser.read') {
      // Fixed read only. Passwords, inputs, cookies and localStorage are never
      // extracted for model context; owners see rendered pixels on the private route.
      return {url:page.url().split(/[?#]/)[0],title:(await page.title()).slice(0,250),
        text:(await page.locator('body').innerText({timeout:2000})).slice(0,4000)};
    } else if(op==='browser.input') {
      if(input.kind==='click')await page.mouse.click(input.x,input.y);
      else if(input.kind==='key')await page.keyboard.press(input.key);
      else await page.keyboard.insertText(input.text);
      await page.waitForLoadState('domcontentloaded',{timeout:2000}).catch(()=>{});
    }
    return {ok:true};
  } finally {
    context.off('page',popup);page.off('dialog',dismiss);
    await context.unroute('**/*',guard).catch(()=>{});
  }
}

export function browserFailure(stage,error) {
  const message=String(error?.message ?? '');
  if(stage==='browser_connect') {
    if(/\b(?:401|403|AccessDenied|Forbidden)\b/i.test(message))return 'browser_connect_denied';
    if(/\b(?:400|404|409|429|500|502|503|504)\b/.test(message))return 'browser_connect_http';
    if(/ECONN|ENET|ENOTFOUND|ETIMEDOUT|timed? ?out|certificate/i.test(message))return 'browser_connect_network';
    if(/EACCES|EPERM|EROFS|ENOENT|mkdtemp|EEXIST/i.test(message))return 'browser_connect_filesystem';
    if(/Protocol error|Target closed|Target page|closed before|context is closed/i.test(message))return 'browser_connect_protocol';
    return 'browser_connect';
  }
  if(stage==='browser_context')return 'browser_context';
  if(/Only HTTP or HTTPS|Invalid URL|outside the browser profile|private address|non-public/i.test(message))return 'browser_page_origin';
  if(/Protocol error|Target closed|Target page|closed before|timeout/i.test(message))return 'browser_action_protocol';
  return 'browser_action';
}

export function agentCoreInteractiveBrowser({region=process.env.AWS_REGION||'us-east-1',browserIdentifier='aws.browser.v1',control=browserControl,deliveryOrigin}={}) {
  if(browserIdentifier!=='aws.browser.v1'||!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region))throw new Error('Invalid public browser configuration.');
  async function service(fn){const api=await control(region,browserIdentifier);try{return await fn(api);}finally{api.close();}}
  async function act(sessionId,op,input,origins) {
    return service(async api=>{
      let stage='browser_connect',browser;
      try {
        browser=await api.connect(sessionId);
        stage='browser_context';
        const context=browser.contexts()[0];
        if(!context)throw new Error('Browser session unavailable.');
        stage='browser_action';
        return await operate(context,op,input,{origins,deliveryOrigin:await configured(deliveryOrigin)});
      } catch(error) {
        // WebSocket exceptions may include the entire signed handshake. Export only fixed categories.
        spanAttributes({reason:browserFailure(stage,error)});
        throw error;
      } finally {if(browser)await browser.close();}
    });
  }
  return {validate:async(url,origins)=>check(url,origins,undefined,await configured(deliveryOrigin)),action:act,
    async start(s,permit) {
      const signal=AbortSignal.timeout(10_000);
      const sessionId=await service(api=>api.start(signal,{clientToken:permit?.startToken()??s.id,timeoutSeconds:browserSessionSeconds.interactive,guardNetwork:true,profileId:s.profileId}));
      if(!sessionId)throw new Error('AgentCore browser failed to start.');
      if(s.url)await act(sessionId,'browser.navigate',{url:s.url},s.origins);
      return sessionId;
    },
    save:(id,p,token)=>service(api=>api.save(id,p,token)),stop:id=>service(api=>api.stop(id))};
}

export function localInteractiveBrowser({dataDir,fixtureOrigin,deliveryOrigin}={}) {
  const sessions=new Map(),starts=new Map();
  async function stop(id){const s=sessions.get(id);if(s){sessions.delete(id);clearTimeout(s.timer);await s.browser.close();await rm(s.temp,{recursive:true,force:true});}}
  async function start(s) {
    if(sessions.has(s.id))return s.id;
    if(starts.has(s.id))return starts.get(s.id);
    const operation=(async()=>{
      const {chromium}=await import('playwright-core');
      const temp=await mkdtemp(join(tmpdir(),'perottino-employee-browser-'));
      let browser;
      try {
        browser=await chromium.launch({chromiumSandbox:process.env.PEROTTINO_BROWSER_EXTERNAL_SANDBOX!=='1',
          downloadsPath:temp,proxy:{server:'http://browser-requests.invalid:443',bypass:'<-loopback>'},
          args:['--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-quic']});
        let state;
        if(s.profileId){try{state=JSON.parse(await readFile(join(dataDir,'browser-profiles',s.profileId+'.json'),'utf8'));}
          catch(error){if(error.code!=='ENOENT')throw error;}}
        const context=await browser.newContext({viewport,javaScriptEnabled:true,serviceWorkers:'block',acceptDownloads:false,storageState:state});
        await context.routeWebSocket('**/*',route=>route.close());
        await context.newPage();
        const timer=setTimeout(()=>void stop(s.id).catch(()=>{}),Math.max(1000,s.expiresAt-Date.now()));timer.unref();
        sessions.set(s.id,{browser,context,temp,timer});
        if(s.url)await operate(context,'browser.navigate',{url:s.url},{origins:s.origins,fixtureOrigin,deliveryOrigin:await configured(deliveryOrigin)});
        return s.id;
      }catch(e){if(sessions.has(s.id))await stop(s.id);else{await browser?.close();await rm(temp,{recursive:true,force:true});}throw e;}
    })();
    starts.set(s.id,operation);
    try{return await operation;}finally{starts.delete(s.id);}
  }
  const session=id=>{const s=sessions.get(id);if(!s)throw Object.assign(new Error('Local browser process ended. Stop the session and start again.'),{status:409});return s;};
  return {validate:async(url,origins)=>check(url,origins,fixtureOrigin,await configured(deliveryOrigin)),start,stop,
    action:async(id,op,input,origins)=>operate(session(id).context,op,input,{origins,fixtureOrigin,deliveryOrigin:await configured(deliveryOrigin)}),
    async save(id,profile){const dir=join(dataDir,'browser-profiles');await mkdir(dir,{recursive:true,mode:0o700});
      const temporary=join(dir,randomUUID()+'.tmp');
      try{await writeFile(temporary,JSON.stringify(await session(id).context.storageState()),{mode:0o600,flag:'wx'});
        await rename(temporary,join(dir,profile+'.json'));}finally{await rm(temporary,{force:true});}},
    async close(){await Promise.all([...sessions.keys()].map(stop));}};
}
