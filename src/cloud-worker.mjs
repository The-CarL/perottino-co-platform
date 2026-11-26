import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { makeAgentCoreBrowser } from './agentcore-browser.mjs';
import { createTurnTools, runTurn, sdkDecision } from './agent.mjs';

const turnTimeoutMs = 120_000;
const leaseMs = 150_000;

// The orchestrator retries business contention separately from actual worker failures.
export const workerExit = { done: 0, retry: 1, busy: 75 };

export async function executeCloudTurn({ agentId, turnId, store, browse = makeAgentCoreBrowser(),
  decide = sdkDecision, signal: cancellation, timeoutMs = turnTimeoutMs }) {
  if (!agentId || !turnId) throw new Error('Both AGENT_ID and TURN_ID are required.');
  const claimed = await store.claimTurn(agentId, turnId, leaseMs);
  if (claimed.state === 'busy') return workerExit.busy;
  if (claimed.state === 'done' || claimed.state === 'error') return workerExit.done;
  if (claimed.state !== 'claimed' || !claimed.job) throw new Error('Could not resolve the queued turn.');
  const job = claimed.job;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
  try {
    signal.throwIfAborted();
    const tools = createTurnTools(job, browse, signal);
    const reply = await runTurn({ ...job, ...tools, signal, retryBrowserFailure: true }, { mode: 'bedrock', decide });
    signal.throwIfAborted();
    if (!reply?.trim()) throw new Error('Empty employee reply.');
    if (await store.complete(job, reply.trim(), tools.pending)) return workerExit.done;
    // Covers a lease lost to another attempt or a memory correction racing with our snapshot.
    await store.release(job);
    return workerExit.busy;
  } catch (error) {
    // Release is fenced. If complete committed before the response was lost, this cannot undo it.
    // A failed release leaves a recoverable lease. Never publish a reply for a failed model call.
    try { await store.release(job); } catch { /* lease expiration permits recovery */ }
    throw error;
  }
}

async function main() {
  const stop = new AbortController();
  const abort = () => stop.abort(new Error('Worker stopping.'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const { createCloudStore } = await import('./cloud-store.mjs');
    const store = createCloudStore({ tableName: process.env.PEROTTINO_STATE_TABLE });
    try {
      return await executeCloudTurn({ store, agentId: process.env.AGENT_ID, turnId: process.env.TURN_ID,
        signal: stop.signal });
    } finally { await store.close?.(); }
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    // Stdout/stderr become CloudWatch logs. Keep prompts, credentials, URLs and private notes out.
    console.error('Employee turn did not complete; the workflow will reconcile or retry.');
    process.exitCode = workerExit.retry;
  });
}
