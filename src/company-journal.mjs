import { eventRows } from './company-events.mjs';

const maxSteps = 6;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Private to the bound worker. Model decisions are durable before any external
// write. Results contain only bounded, projected receipts, never credentials.
export function makeCompanyJournal({ records, now = Date.now }) {
  return { async execute(actor, op, input = {}) {
    const id = typeof actor === 'string' ? actor : actor?.id;
    if (!id || id === 'owner') throw bad('Worker identity required.', 403);
    if (!/^[a-f0-9]{64}$/.test(input.id ?? '')) throw bad('Invalid journal ID.');
    const pk = 'JOURNAL#' + id;
    const sk = input.id;
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await records.get(pk, sk);
      const entry = row?.entry ?? { steps: [], failures: 0, retryAt: 0 };
      if (op === 'journal.get') return { entry };
      const next = structuredClone(entry);
      const events = [];
      if (op === 'journal.fail') {
        if (typeof input.attemptId !== 'string' || input.attemptId.length > 100) throw bad('Invalid attempt.');
        if (next.lastAttempt === input.attemptId) return { entry };
        next.lastAttempt = input.attemptId;
        next.failures++;
        next.retryAt = now() + Math.min(300_000, 2000 * 2 ** Math.min(8, next.failures));
        if (next.failures === 3 && ['plan','close','task','review'].includes(input.kind)) {
          const resource = ['plan','close'].includes(input.kind) ? 'goal' : 'task';
          events.push(...eventRows(resource + '.worker_failed', { actor:id, [resource+'Id']:input.workId,
            status:'failed', reasonCode:'retry_limit' },'worker-failure-'+input.id));
        }
      } else {
        const { index } = input;
        if (!Number.isInteger(index) || index < 0 || index >= maxSteps) throw bad('Invalid step.');
        if (op === 'journal.stage') {
          if (entry.steps[index]) return { entry };
          if (index !== entry.steps.length || (index > 0 && !Object.hasOwn(entry.steps[index - 1], 'result'))) throw bad('Step is not ready.', 409);
          if (!input.decision || typeof input.decision.op !== 'string' || Buffer.byteLength(JSON.stringify(input.decision)) > 20_000) throw bad('Invalid decision.');
          next.steps.push({ decision: input.decision });
        } else if (op === 'journal.confirm') {
          if (!entry.steps[index]) throw bad('Step has not been staged.', 409);
          if (Object.hasOwn(entry.steps[index], 'result')) return { entry };
          if (!input.result || Buffer.byteLength(JSON.stringify(input.result)) > 24_000) throw bad('Invalid receipt.');
          next.steps[index].result = input.result;
          next.failures = 0;
          next.retryAt = 0;
        } else throw bad('Unknown journal command.', 404);
      }
      if (await records.transact([{ pk, sk, expect: row?.version ?? null, value: { entry: next } },...events])) return { entry: next };
    }
    throw bad('Concurrent worker journal update.', 503);
  } };
}
