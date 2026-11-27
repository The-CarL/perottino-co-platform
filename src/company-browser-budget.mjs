import {createHash} from 'node:crypto';

export const browserSessionSeconds = Object.freeze({document:90, interactive:900});
const allowanceKey = 'browser:monthly-allowance';
const permitKey = 'browser:start-permits';
const month = time => new Date(time).toISOString().slice(0, 7);
const fail = (status, code, message) => Object.assign(new Error(message), {status, code});
const maxAdmissionMs = 30_000;
const maxProviderStartMs = 30_000;

function reserved(row) {
  if (!row) return 0;
  if (!Number.isSafeInteger(row.reservedSeconds) || row.reservedSeconds < 0)
    throw fail(503, 'BROWSER_ADMISSION_BUSY', 'Browser allowance unavailable.');
  return row.reservedSeconds;
}

export function createBrowserBudget({records, minutes, now = Date.now}) {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1_000_000)
    throw new Error('Invalid monthly browser allowance.');
  const limit = minutes * 60;

  async function usage() {
    const current = month(now());
    const reservedSeconds = reserved(await records.get(allowanceKey, current));
    return {month:current, limitMinutes:minutes, reservedSeconds, remainingSeconds:Math.max(0, limit - reservedSeconds)};
  }

  function permit(token, deadline) {
    return {startToken() {
      if (!Number.isSafeInteger(deadline) || now() >= deadline)
        throw fail(409, 'BROWSER_ADMISSION_EXPIRED', 'The browser start timed out before dispatch.');
      return token;
    }};
  }

  async function reserve(actor, kind, requestId, sessionWrites = []) {
    if (!Object.hasOwn(browserSessionSeconds, kind) || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(requestId))
      throw fail(400, 'INVALID_BROWSER_START', 'Invalid browser admission.');
    const seconds = browserSessionSeconds[kind];
    const receipt = createHash('sha256').update(JSON.stringify([actor, kind, requestId])).digest('hex');
    for (let attempt = 0; attempt < 10; attempt++) {
      const at = now();
      const deadline = at + maxAdmissionMs;
      // The service may accept a start late in the bounded request. Cover its entire
      // session in each UTC month it could touch, even if the response is lost.
      const lastMonth = month(deadline + maxProviderStartMs + seconds * 1000);
      const months = [...new Set([month(at), lastMonth])];
      const [prior, ...rows] = await Promise.all([records.get(permitKey, receipt), ...months.map(sk => records.get(allowanceKey, sk))]);
      if (prior) {
        // A stored interactive session reuses its original provider token and deadline.
        // A racing new session must re-read the stored signature and profile first.
        if (kind === 'interactive' && sessionWrites.length === 0) return permit(requestId, prior.deadline);
        throw fail(409, 'BROWSER_ADMISSION_USED', 'This browser start was already admitted. Refresh the session state.');
      }
      if (rows.some(row => reserved(row) + seconds > limit))
        throw fail(429, 'BROWSER_ALLOWANCE_EXHAUSTED', 'The company monthly browser allowance is exhausted.');
      const changes = months.map((sk, i) => ({pk:allowanceKey, sk, expect:rows[i]?.version ?? null,
        value:{reservedSeconds:reserved(rows[i]) + seconds}}));
      changes.push({pk:permitKey, sk:receipt, expect:null, value:{kind, seconds, months, deadline}});
      if (await records.transact([...changes, ...sessionWrites]))
        return permit(kind === 'interactive' ? requestId : receipt, deadline);
    }
    throw fail(503, 'BROWSER_ADMISSION_BUSY', 'Browser allowance changed concurrently. Retry.');
  }
  return {reserve, usage};
}
