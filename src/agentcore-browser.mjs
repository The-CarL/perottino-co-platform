import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeBrowser } from './browser.mjs';
import { withSpan } from './telemetry.mjs';
import { readBrowserDocument } from './renderer.mjs';

const sessionSeconds = 90;

export async function browserControl(region, browserIdentifier, { client: providedClient, connectCDP } = {}) {
  const [{ BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand, SaveBrowserSessionProfileCommand },
    { SignatureV4 }, { HttpRequest }, { Sha256 }, { chromium }] = await Promise.all([
    import('@aws-sdk/client-bedrock-agentcore'), import('@smithy/signature-v4'),
    import('@smithy/protocol-http'), import('@aws-crypto/sha256-js'), import('playwright-core'),
  ]);
  const client = providedClient ?? new BedrockAgentCoreClient({ region, maxAttempts: 2 });
  const openCDP = connectCDP ?? ((endpoint, options) => chromium.connectOverCDP(endpoint, options));
  return {
    async start(signal,options={}) {
      const clientToken = options.clientToken??randomUUID();
      const result = await client.send(new StartBrowserSessionCommand({
        browserIdentifier, name: 'perottino-' + clientToken, clientToken,
        sessionTimeoutSeconds: options.timeoutSeconds??sessionSeconds,
        ...(options.profileId&&{profileConfiguration:{profileIdentifier:options.profileId}}),
        ...(options.guardNetwork&&{proxyConfiguration:{proxies:[{externalProxy:{server:'browser-requests.invalid',port:443}}]}}), viewPort: { width: 1280, height: 800 },
      }), { abortSignal: signal });
      return result.sessionId;
    },
    async connect(sessionId) {
      // Build and sign the documented regional AWS stream endpoint. Site-supplied URLs
      // never receive these headers or determine the WebSocket host, path or session.
      const host = 'bedrock-agentcore.' + region + '.amazonaws.com';
      const route = '/browser-streams/' + encodeURIComponent(browserIdentifier) +
        '/sessions/' + encodeURIComponent(sessionId) + '/automation';
      const signer = new SignatureV4({ service: 'bedrock-agentcore', region,
        credentials: client.config.credentials, sha256: Sha256 });
      const signed = await signer.sign(new HttpRequest({ method: 'GET', protocol: 'wss:',
        hostname: host, path: route, headers: { host } }));
      return openCDP('wss://' + host + route, { headers: signed.headers, timeout: 8000 });
    },
    async save(sessionId,profileIdentifier,clientToken) {
      await client.send(new SaveBrowserSessionProfileCommand({browserIdentifier,sessionId,profileIdentifier,clientToken}),
        {abortSignal:AbortSignal.timeout(8000)});
    },
    async stop(sessionId) {
      await client.send(new StopBrowserSessionCommand({ browserIdentifier, sessionId }),
        { abortSignal: AbortSignal.timeout(5000) });
    },
    close() { client.destroy(); },
  };
}

export function makeAgentCoreBrowser({
  region = process.env.AWS_REGION || 'us-east-1', browserIdentifier = process.env.PEROTTINO_BROWSER_ID || 'aws.browser.v1',
  control = browserControl, read = readBrowserDocument, fixtureOrigin,
} = {}) {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Invalid browser Region.');
  // This release uses the isolated, public, built-in browser only. No owner profile or VPC browser.
  if (browserIdentifier !== 'aws.browser.v1') throw new Error('Only the built-in public browser is supported.');
  async function render(document, signal) {
    signal.throwIfAborted();
    const service = await control(region, browserIdentifier);
    let sessionId;
    let connection;
    const disconnect = () => { connection?.close().catch(() => {}); };
    try {
      sessionId = await service.start(signal);
      if (!sessionId) throw new Error('AgentCore did not return a browser session.');
      signal.throwIfAborted();
      connection = await service.connect(sessionId);
      signal.addEventListener('abort', disconnect, { once: true });
      signal.throwIfAborted();
      return await read(connection, document);
    } finally {
      signal.removeEventListener('abort', disconnect);
      try {
        if (connection) await Promise.race([connection.close().catch(() => {}), sleep(1500, undefined, { ref: false })]);
        if (sessionId) await service.stop(sessionId);
      } finally { service.close(); }
    }
  }
  const browse = makeBrowser({ render, fixtureOrigin });
  return (url, options) => withSpan('browser.read', {}, () => browse(url, options));
}
