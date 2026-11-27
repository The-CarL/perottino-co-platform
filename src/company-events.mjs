import { createHash } from 'node:crypto';
import { traceCarrier } from './telemetry.mjs';

const fields = ['actor', 'conversationId', 'messageId', 'goalId', 'taskId', 'employeeId', 'assigneeId', 'reviewerId', 'accountableId', 'status', 'reasonCode'];

// This allowlist is the public audit schema. Business content belongs in its
// access-controlled record, never inside a company activity row.
export function eventRows(kind, attributes, eventId) {
  if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(kind) || !eventId) throw new Error('Invalid company event');
  const id = createHash('sha256').update(JSON.stringify([kind, attributes.actor, eventId])).digest('hex');
  const timestamp = Date.now();
  const value = { id, kind, at: new Date(timestamp).toISOString() };
  for (const key of fields) {
    const item = attributes[key];
    if (typeof item === 'string' && /^[A-Za-z0-9_.:/#-]{1,180}$/.test(item)) value[key] = item;
  }
  const traceId = traceCarrier()?.traceparent?.split('-')[1];
  if (traceId && /^[a-f0-9]{32}$/.test(traceId)) value.traceId = traceId;
  const sk = String(9999999999999 - timestamp).padStart(13, '0') + '#' + id;
  return [
    { pk: 'event-id', sk: id, expect: null, value: { id } },
    { pk: 'company-events', sk, expect: null, value },
    ...(/^(?:goal|task|employee)\./.test(kind) ? [{ pk: 'work-events', sk, expect: null, value }] : []),
  ];
}
