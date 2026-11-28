import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { checkedRenderResult, renderDocument, maxDocumentBytes } from './renderer.mjs';
import path from 'node:path';

const deadlineMs = 30_000;
const deniedIPv4 = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) deniedIPv4.addSubnet(ip, prefix, 'ipv4');

const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const deniedIPv6 = new BlockList();
for (const [ip, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) deniedIPv6.addSubnet(ip, prefix, 'ipv6');

function publicAddress(address) {
  if (isIP(address) === 4) return !deniedIPv4.check(address, 'ipv4');
  return isIP(address) === 6 && globalIPv6.check(address, 'ipv6') &&
    !deniedIPv6.check(address, 'ipv6');
}

function validatedUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Invalid page URL.');
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter a complete HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP or HTTPS pages without embedded credentials are supported.');
  }
  return url;
}

function beforeAbort(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolveAddress(url, signal, fixtureOrigin) {
  const name = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // The test-only exception is one literal loopback origin including its ephemeral port.
  if (fixtureOrigin && url.origin === fixtureOrigin && ['127.0.0.1', '::1'].includes(name)) {
    return name;
  }
  if ((url.port && !['80', '443'].includes(url.port)) ||
      (!isIP(name) && (!name.includes('.') || /(?:^|\.)(localhost|local|internal|home\.arpa)$/.test(name)))) {
    throw new Error('Browsing is limited to public web destinations.');
  }
  const answers = isIP(name) ? [{ address: name }] :
    await beforeAbort(lookup(name, { all: true, verbatim: true }), signal);
  if (!answers.length || answers.some(({ address }) => !publicAddress(address))) {
    throw new Error('Browsing is limited to public web destinations.');
  }
  return answers.find(({address}) => isIP(address) === 4)?.address ?? answers[0].address;
}

// The configured proxy sees only a validated numeric CONNECT target. DNS rebinding cannot
// change the target at the proxy. Origin TLS still verifies the requested public hostname.
async function proxyConnection(proxyValue, url, address, signal) {
  const proxy = new URL(proxyValue);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Invalid outbound proxy.');
  const port = url.port || (url.protocol === 'https:' ? 443 : 80);
  const authority = (isIP(address) === 6 ? '[' + address + ']' : address) + ':' + port;
  const headers = { Host: authority };
  if (proxy.username || proxy.password) {
    const credentials = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password);
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(credentials).toString('base64');
  }
  const socket = await new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? https : http).request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || undefined,
      method: 'CONNECT', path: authority, headers, agent: false, signal,
    });
    request.on('error', reject);
    request.on('connect', (response, connection, head) => {
      if (response.statusCode !== 200 || head.length) {
        connection.destroy();
        reject(new Error('Outbound proxy refused the page.')); return;
      }
      resolve(connection);
    });
    request.end();
  });
  // Agent owns the already connected socket; no further DNS or proxy credential is involved.
  const secure = url.protocol === 'https:';
  const agent = secure ? new https.Agent() : new http.Agent();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  agent.createConnection = () => secure ? tls.connect({
    socket, host: hostname, ...(isIP(hostname) ? {} : { servername: hostname }),
  }) : socket;
  return agent;
}

async function fetchDocument(url, address, signal, useProxy) {
  const secure = url.protocol === 'https:';
  const proxy = useProxy && (process.env.PEROTTINO_BROWSER_PROXY_URL ||
    (secure ? process.env.HTTPS_PROXY || process.env.HTTP_PROXY : process.env.HTTP_PROXY));
  const agent = proxy ? await proxyConnection(proxy, url, address, signal) : false;
  // Pin the socket to the validated DNS result. TLS and the Host header still authenticate the origin.
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      hostname: address, port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search, method: 'GET', agent, signal,
      ...(secure && !isIP(url.hostname.replace(/^\[|\]$/g, '')) ? { servername: url.hostname } : {}),
      headers: { Host: url.host, Accept: 'text/html, text/plain', 'Accept-Encoding': 'identity',
        'User-Agent': 'Perottino-Reader/1.0' },
    }, res => {
      res.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        resolve({ redirect: res.headers.location }); res.destroy(); return;
      }
      const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (res.statusCode < 200 || res.statusCode >= 300 || !['text/html', 'text/plain'].includes(type) ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        reject(new Error('This page did not return a readable HTML or text document.')); res.destroy(); return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxDocumentBytes) {
          reject(new Error('Page exceeds the browser size limit.')); res.destroy(); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
      res.on('aborted', () => reject(new Error('Page download interrupted.')));
    });
    req.on('error', reject);
    req.end();
  });
}

function renderViaSocket(socketPath, document, signal) {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103 || socketPath.includes('\0')) {
    throw new Error('Invalid renderer socket path.');
  }
  // Send only the vetted MIME type and bounded raw bytes. The renderer never learns the public URL.
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath, method: 'POST', path: '/render', signal, agent: false,
      headers: { 'Content-Type': document.type, 'Content-Length': document.body.length },
    }, response => {
      response.on('error', reject);
      if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json') {
        response.destroy();
        reject(new Error('The renderer could not process the document.'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        // Worst-case JSON escaping uses six bytes per code unit of output.
        if (size > 64 * 1024) {
          response.destroy();
          reject(new Error('Renderer response exceeded its size limit.'));
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(checkedRenderResult(JSON.parse(Buffer.concat(chunks))));
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(document.body);
  });
}

export async function browse(input, { signal: externalSignal, fixtureOrigin, render } = {}) {
  const timeout = AbortSignal.timeout(deadlineMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  let url = validatedUrl(input);
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const address = await resolveAddress(url, signal, fixtureOrigin);
    const document = await fetchDocument(url, address, signal, url.origin !== fixtureOrigin);
    if (!document.redirect) {
      try {
        const socket = process.env.PEROTTINO_BROWSER_RENDER_SOCKET;
        const renderer = render ?? (socket ? (doc, sig) => renderViaSocket(socket, doc, sig) : renderDocument);
        const result = await renderer(document, signal);
        return { url: url.href, ...result };
      } catch (cause) {
        signal.throwIfAborted();
        if (['BROWSER_ALLOWANCE_EXHAUSTED','BROWSER_ADMISSION_USED','BROWSER_ADMISSION_EXPIRED','BROWSER_ADMISSION_BUSY'].includes(cause?.code)) throw cause;
        const failure = new Error('Browser could not render this page. Check the Chromium worker configuration.', { cause });
        failure.code = 'BROWSER_RENDER_FAILED';
        throw failure;
      }
    }
    if (redirects === 4) throw new Error('Too many redirects.');
    url = validatedUrl(new URL(document.redirect, url).href);
  }
}

export function makeBrowser({ fixtureOrigin, render } = {}) {
  return (url, { signal } = {}) => browse(url, { signal, fixtureOrigin, render });
}

// Interactive sessions mediate HTTP through the same public-address checks as
// the document reader. Chromium never gets the broker's AWS or proxy headers.
export async function validatePublicPage(raw,{origins,fixtureOrigin,signal=AbortSignal.timeout(5000)}={}) {
  const url=validatedUrl(raw);
  if(origins && !origins.includes(url.origin))throw Object.assign(new Error('Outside the browser profile origins.'),{status:403});
  const address=await resolveAddress(url,signal,fixtureOrigin);
  return {url,address};
}

export async function interactiveResource({raw,origins,method,headers={},body,fixtureOrigin,signal,site=false}) {
  const {url,address}=await validatePublicPage(raw,{origins,fixtureOrigin,signal});
  if(!['GET','HEAD','POST'].includes(method)||method==='POST'&&(!origins||url.protocol!=='https:')||body?.length>65536)
    throw new Error('Unsupported browser request.');
  const secure=url.protocol==='https:',host=url.hostname.replace(/^\[|\]$/g,'');
  const proxy=url.origin!==fixtureOrigin && (process.env.PEROTTINO_BROWSER_PROXY_URL || (secure?process.env.HTTPS_PROXY:process.env.HTTP_PROXY));
  const agent=proxy ? await proxyConnection(proxy,url,address,signal):false;
  const out={Host:url.host,'Accept-Encoding':'identity','User-Agent':'Perottino-Interactive/1.0',Accept:headers.accept||'*/*'};
  // The origin check is per request, including subresources/forms. Clean public
  // sessions cannot forward cookies, tokens, or credentials from owner profiles.
  for(const key of ['cookie','content-type','origin'])if(origins&&headers[key])out[key]=headers[key];
  return new Promise((resolve,reject)=>{
    const req=(secure?https:http).request({hostname:address,port:url.port||undefined,path:url.pathname+url.search,method,
      headers:out,agent,signal,...(secure&&!isIP(host)&&{servername:host})},res=>{
      const chunks=[];let length=0;
      res.on('data',c=>{length+=c.length;if(length>1024*1024){res.destroy(new Error('Browser resource exceeds limit.'));return;}chunks.push(c);});
      res.on('error',reject);
      res.on('end',()=>{
        const type=String(res.headers['content-type']||'application/octet-stream');
        const filtered={'content-type':type,'referrer-policy':'no-referrer','x-content-type-options':'nosniff',
          // Passive HTML/forms keep background scripts, WebRTC, service workers
          // and unattended network activity out of a disconnected browser.
          'content-security-policy':"default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline' http: https:; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-forms allow-same-origin"};
        if(site) {
          filtered['content-security-policy']="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-scripts";
          filtered['access-control-allow-origin']='*';
        }
        const cookies=origins && secure && res.headers['set-cookie']?.join('\n');
        const location=res.headers.location;
        if([301,302,303,307,308].includes(res.statusCode)&&location){
          let target;
          try { target=validatedUrl(new URL(location,url).href); }
          catch(error) { reject(error);return; }
          if(cookies && target.origin===url.origin)filtered['set-cookie']=cookies;
          // Chromium can bypass Playwright routing after an HTTP redirect. Keep
          // the redirect explicit; clicking must go through the pinned fetcher.
          const escaped=target.href.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
          resolve({status:200,headers:{...filtered,'content-type':'text/html'},body:Buffer.from('<a href="'+escaped+'">Continue to redirected page</a>')});return;
        }
        if(cookies)filtered['set-cookie']=cookies;
        resolve({status:res.statusCode,headers:filtered,body:Buffer.concat(chunks)});
      });
    });
    req.on('error',reject);req.end(body);
  });
}
