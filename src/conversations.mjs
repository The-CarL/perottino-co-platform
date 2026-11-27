import { createHash, randomUUID } from 'node:crypto';
import { eventRows } from './company-events.mjs';
import { traceCarrier } from './telemetry.mjs';

const owner = 'owner';
const catalog = 'CONVERSATIONS';
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const indexKey = id => 'C#' + id;
const messageIndex = id => 'ID#' + id;
const bucket = id => 'PARTICIPANT#' + hash(id).slice(0, 1);
const stream = id => 'CONVERSATION#' + id;
const inbox = actor => 'INBOX#' + actor;
const sequence = n => 'S#' + String(n).padStart(16, '0');
const queued = msg => 'P#' + msg.createdAt + '#' + msg.conversationId + '#' + sequence(msg.seq);
const deliveryKey = id => 'DELIVERY#' + id;
const queue = id => 'QUEUE#' + hash(id).slice(0, 1);
const insert = (pk, sk, value) => ({ pk, sk, expect: null, value });
const update = (row, value) => ({ pk: row.pk, sk: row.sk, expect: row.version, value });
const strip = ({ pk, sk, version, ...data }) => data;
const publicConversation = ({ id, type, title, members, createdBy, createdAt }) => ({ id, type, title, members, createdBy, createdAt });

function error(status, message) { return Object.assign(new Error(message), { status }); }
function string(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(400, 'Invalid ' + label + '.');
  return value.trim();
}
function participant(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw error(400, 'Invalid participant ID.');
  return value;
}
function reference(value, prefix) {
  if (typeof value !== 'string' || !new RegExp('^' + prefix + '-[a-f0-9]{40}$').test(value)) throw error(400, 'Invalid record ID.');
  return value;
}
function participants(value, label) {
  if (!Array.isArray(value) || value.length > 101) throw error(400, 'Invalid ' + label + '.');
  return [...new Set(value.map(participant))].sort();
}
function pageSize(value) {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw error(400, 'Invalid page size.');
  return value;
}
function cursor(value, pattern) {
  if (value !== undefined && (typeof value !== 'string' || !pattern.test(value))) throw error(400, 'Invalid cursor.');
  return value;
}
async function retry(action) {
  for (let i = 0; i < 12; i++) {
    const result = await action();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(16, 2 ** i)));
  }
  throw error(409, 'The conversation changed concurrently. Retry this operation.');
}

export function createConversations({ records, employee, now = Date.now }) {
  async function available(id) {
    if (id === owner) return;
    const person = await employee(id);
    if (!person || person.desiredState === 'fired') throw error(404, 'Participant unavailable.');
  }
  async function actorAllowed(actor) {
    participant(actor);
    if (actor === owner) return;
    const person = await employee(actor);
    if (!person || person.desiredState !== 'active') throw error(403, 'Employee is inactive.');
  }
  async function conversation(actor, id, admin = false) {
    reference(id, 'c');
    const row = await records.get(catalog, indexKey(id));
    if (!row || (!admin && !row.members.includes(actor))) throw error(404, 'Conversation not found.');
    return row;
  }
  async function message(conv, id) {
    reference(id, 'm');
    const index = await records.get(stream(conv.id), messageIndex(id));
    if (!index) throw error(404, 'Message not found.');
    const row = await records.get(stream(conv.id), sequence(index.seq));
    if (!row || row.id !== id) throw error(404, 'Message not found.');
    return strip(row);
  }
  async function auditRead(actor, kind, ids) {
    const id = randomUUID();
    if (!await records.transact(eventRows(kind, { actor, ...ids }, id))) throw error(503, 'Could not record administrative access.');
  }
  async function create(actor, input, type) {
    const group = type === 'group';
    const members = group ? [...new Set([actor, ...participants(input.members, 'group members')])].sort()
      : participants([actor, participant(input.peerId)], 'DM participants');
    if (members.length > 101) throw error(400, 'Group exceeds the company participant limit.');
    if (members.length < 2) throw error(400, 'A conversation needs another participant.');
    const title = group ? string(input.title, 160, 'group title') : '';
    const id = 'c-' + (group ? hash('group', actor, string(input.requestId, 160, 'request ID')) : hash('dm', members)).slice(0, 40);
    return retry(async () => {
      const prior = await records.get(catalog, indexKey(id));
      if (prior) {
        if (prior.title !== title || JSON.stringify(prior.members) !== JSON.stringify(members)) throw error(409, 'Request ID already used.');
        return { conversation: publicConversation(prior) };
      }
      await Promise.all(members.map(available));
      const row = { id, type, members, title, createdBy: actor, createdAt: new Date(now()).toISOString() };
      // Index small sets of participants together to keep an all-company group within
      // a single DynamoDB transaction. Only exact members pass the read filter.
      const indexes = [...new Set(members.map(bucket))].map(pk => insert(pk, indexKey(id), row));
      if (await records.transact([insert(catalog, indexKey(id), { ...row, lastSeq: 0 }), ...indexes,
        ...eventRows('conversation.created', { actor, conversationId: id }, 'conversation-' + id)])) return { conversation: row };
    });
  }
  async function listConversations(actor, input, admin) {
    let after = cursor(input.after, /^C#c-[a-f0-9]{40}$/);
    const limit = pageSize(input.limit), conversations = [];
    if (admin) await auditRead(actor, 'admin.conversations.read', {});
    for (;;) {
      const page = await records.list(admin ? catalog : bucket(actor), { prefix: 'C#', after, limit: Math.min(100, limit + 1) });
      for (const row of page.items) {
        if (!admin && !row.members.includes(actor)) continue;
        if (conversations.length === limit) return { conversations, next: indexKey(conversations.at(-1).id) };
        conversations.push(publicConversation(row));
      }
      if (!page.next) return { conversations };
      after = page.next;
    }
  }
  async function listMessages(actor, input, admin) {
    const conv = await conversation(actor, input.conversationId, admin), limit = pageSize(input.limit);
    const after = cursor(input.after, /^S#\d{16}$/);
    if (input.latest !== undefined && typeof input.latest !== 'boolean') throw error(400, 'Invalid latest flag.');
    const before = input.beforeSeq;
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || before > conv.lastSeq + 1)) {
      throw error(400, 'Invalid message sequence boundary.');
    }
    if ([Boolean(input.latest), Boolean(after), before !== undefined].filter(Boolean).length > 1) {
      throw error(400, 'Choose a single pagination direction.');
    }
    if (admin) await auditRead(actor, 'admin.messages.read', { conversationId: conv.id });
    const last = before !== undefined ? before - 1 : input.latest ? conv.lastSeq : null;
    if (last === 0) return { messages: [] };
    const page = await records.list(stream(conv.id), { prefix: 'S#', limit: last === null ? limit : Math.min(limit, last),
      after: last === null ? after : sequence(Math.max(0, last - limit)) });
    const messages = page.items.map(strip);
    return { messages, ...(last === null && page.next && { next: page.next }),
      ...(messages[0]?.seq > 1 && { previousBeforeSeq: messages[0].seq }) };
  }
  function buildMessage(conv, actor, id, text, responders, replyTo) {
    const seq = conv.lastSeq + 1;
    const at = Math.max(now(), conv.lastAt ?? 0);
    const msg = { id, conversationId: conv.id, senderId: actor, seq, text, responders,
      createdAt: new Date(at).toISOString(), ...(replyTo && { replyTo }) };
    const pk = stream(conv.id);
    const traceparent = traceCarrier()?.traceparent;
    const recipients = new Map();
    for (const id of responders) {
      const pk = queue(id);
      if (!recipients.has(pk)) recipients.set(pk, []);
      recipients.get(pk).push(id);
    }
    const changes = [update(conv, { ...strip(conv), lastSeq: seq, lastAt: at }),
      insert(pk, sequence(seq), msg), insert(pk, messageIndex(id), { seq }),
      ...Array.from(recipients, ([pk, pendingFor]) => insert(pk, queued(msg), {
        conversationId: conv.id, messageId: id, pendingFor, ...(traceparent && { traceparent }),
      })), ...eventRows('message.posted', { actor, conversationId: conv.id, messageId: id }, 'post-' + id)];
    return { msg, changes };
  }
  async function post(actor, input) {
    const text = string(input.text, 16_000, 'message'), requestId = string(input.requestId, 160, 'request ID');
    if ('senderId' in input || 'author' in input) throw error(400, 'Message sender is assigned by the service.');
    return retry(async () => {
      const conv = await conversation(actor, input.conversationId);
      const replyTo = input.replyTo === undefined ? undefined : reference(input.replyTo, 'm');
      const responders = input.responders === undefined
        ? (conv.type === 'dm' && !replyTo ? conv.members.filter(id => id !== actor && id !== owner) : [])
        : participants(input.responders, 'responders');
      if (responders.some(id => id === actor || id === owner || !conv.members.includes(id))) throw error(400, 'Invalid responder.');
      const id = 'm-' + hash('post', conv.id, actor, requestId).slice(0, 40);
      const existing = await records.get(stream(conv.id), messageIndex(id));
      if (existing) {
        const prior = await message(conv, id);
        if (prior.text !== text || prior.replyTo !== replyTo || JSON.stringify(prior.responders) !== JSON.stringify(responders)) {
          throw error(409, 'Request ID already used for a different message.');
        }
        return { message: prior };
      }
      await Promise.all(responders.map(available));
      if (replyTo) await message(conv, replyTo);
      const { msg, changes } = buildMessage(conv, actor, id, text, responders, replyTo);
      if (await records.transact(changes)) return { message: msg };
    });
  }
  async function deliverable(actor, input) {
    if (actor === owner) throw error(403, 'Employee delivery requires a bound employee.');
    const conv = await conversation(actor, input.conversationId);
    const msg = await message(conv, input.messageId);
    if (!msg.responders.includes(actor)) throw error(404, 'Delivery not found.');
    return { conv, msg };
  }
  function activeLease(row, token) {
    if (!row || row.status !== 'working' || row.token !== token || row.expiresAt <= now()) throw error(409, 'Delivery lease lost.');
  }
  async function firstScheduled(actor) {
    let after;
    do {
      const page = await records.list(queue(actor), { prefix: 'P#', after, limit: 50 });
      const item = page.items.find(row => row.pendingFor.includes(actor));
      if (item) return item;
      after = page.next;
    } while (after);
    return null;
  }
  function endRows(schedule, row, status, extra = {}) {
    const pendingFor = schedule.pendingFor.filter(id => id !== row.recipientId);
    return [update(schedule, pendingFor.length ? { ...strip(schedule), pendingFor } : null), update(row, {
      conversationId: row.conversationId, messageId: row.messageId, recipientId: row.recipientId,
      status, attempts: row.attempts, ...extra,
    })];
  }
  async function claim(actor, input) {
    if (actor === owner) throw error(403, 'Employee delivery requires a bound employee.');
    const workerId = string(input.workerId, 512, 'worker ID');
    const leaseMs = input.leaseMs ?? 150_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw error(400, 'Invalid lease duration.');
    return retry(async () => {
      const schedule = await firstScheduled(actor);
      if (!schedule) return { delivery: null };
      const pk = inbox(actor), key = deliveryKey(schedule.messageId);
      const row = await records.get(pk, key);
      if (row?.status === 'working' && row.expiresAt > now()) return { delivery: null };
      if (row?.status === 'done' || row?.status === 'failed') return;
      const { conv, msg } = await deliverable(actor, schedule);
      if (row && row.attempts >= 3) {
        await records.transact([...endRows(schedule, row, 'failed'), ...eventRows('delivery.failed',
          { actor, conversationId: conv.id, messageId: msg.id, status: 'failed' }, 'failed-' + msg.id + '-' + actor)]);
        return;
      }
      const token = randomUUID(), expiresAt = now() + leaseMs, attempts = (row?.attempts ?? 0) + 1;
      const next = { ...(row && strip(row)), conversationId: conv.id, messageId: msg.id, recipientId: actor,
        attempts, token, workerId, expiresAt, status: 'working' };
      const history = msg.seq === 1 ? [] : (await records.list(stream(conv.id), { prefix: 'S#',
        after: sequence(Math.max(0, msg.seq - 17)), limit: Math.min(16, msg.seq - 1) })).items.map(strip);
      if (await records.transact([row ? update(row, next) : insert(pk, key, next)])) return { delivery: { id: msg.id, messageId: msg.id,
        conversationId: conv.id, token, attempts, expiresAt, ...(schedule.traceparent && { traceparent: schedule.traceparent }),
        ...(row?.plan !== undefined && { plan: row.plan }) },
        message: msg, conversation: publicConversation(conv), history };
    });
  }
  async function finish(actor, input, operation) {
    const token = string(input.token, 160, 'lease token');
    const reply = input.reply === undefined ? undefined : string(input.reply, 16_000, 'reply');
    const plan = operation === 'stage' ? input.plan : undefined;
    if (operation === 'stage' && (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
        Buffer.byteLength(JSON.stringify(plan)) > 16_384)) throw error(400, 'Invalid delivery plan.');
    return retry(async () => {
      const { conv, msg } = await deliverable(actor, input);
      const row = await records.get(inbox(actor), deliveryKey(msg.id));
      if (operation === 'ack' && row?.status === 'done' && row.receipt === hash(token, reply ?? null)) {
        return { ok: true, ...(row.replyId && { message: await message(conv, row.replyId) }) };
      }
      activeLease(row, token);
      const schedule = await records.get(queue(actor), queued(msg));
      if (!schedule?.pendingFor.includes(actor)) throw error(409, 'Delivery is no longer scheduled.');
      if (operation === 'stage') {
        if (row.plan !== undefined) return { plan: row.plan };
        if (await records.transact([update(row, { ...strip(row), plan })])) return { plan };
      } else if (operation === 'ack') {
        const delivery = reply ? buildMessage(conv, actor, 'm-' + hash('auto-reply', msg.id, actor).slice(0, 40),
          reply, [], msg.id) : { changes: [] };
        const changes = [...endRows(schedule, row, 'done', { receipt: hash(token, reply ?? null), ...(delivery.msg && { replyId: delivery.msg.id }) }),
          ...delivery.changes, ...eventRows('delivery.completed', { actor, conversationId: conv.id, messageId: msg.id, status: 'done' },
            'delivered-' + msg.id + '-' + actor)];
        if (await records.transact(changes)) return { ok: true, ...(delivery.msg && { message: delivery.msg }) };
      } else if (input.terminal === true || row.attempts >= 3) {
        if (await records.transact([...endRows(schedule, row, 'failed'), ...eventRows('delivery.failed',
          { actor, conversationId: conv.id, messageId: msg.id, status: 'failed' }, 'failed-' + msg.id + '-' + actor)])) return { ok: true };
      } else {
        const { token: oldToken, workerId, expiresAt, ...data } = strip(row);
        if (await records.transact([update(row, { ...data, status: 'queued' })])) return { ok: true };
      }
    });
  }
  async function status(actor, input) {
    const conv = await conversation(actor, input.conversationId), msg = await message(conv, input.messageId);
    const deliveries = await Promise.all(msg.responders.map(async recipientId => {
      const row = await records.get(inbox(recipientId), deliveryKey(msg.id));
      return { recipientId, status: row?.status ?? 'queued', attempts: row?.attempts ?? 0 };
    }));
    return { deliveries };
  }
  async function execute(actor, op, input = {}) {
    await actorAllowed(actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error(400, 'Invalid conversation input.');
    if (op.startsWith('admin.') && actor !== owner) throw error(403, 'Administrative access requires the owner.');
    switch (op) {
      case 'conversations.get': return { conversation: publicConversation(await conversation(actor, input.conversationId)) };
      case 'messages.get': return { message: await message(await conversation(actor, input.conversationId), input.messageId) };
      case 'conversations.list': return listConversations(actor, input, false);
      case 'conversations.dm': return create(actor, input, 'dm');
      case 'conversations.group': return create(actor, input, 'group');
      case 'messages.list': return listMessages(actor, input, false);
      case 'messages.post': return post(actor, input);
      case 'messages.status': return status(actor, input);
      case 'admin.conversations': return listConversations(actor, input, true);
      case 'admin.messages': return listMessages(actor, input, true);
      case 'deliveries.claim': return claim(actor, input);
      case 'deliveries.stage': return finish(actor, input, 'stage');
      case 'deliveries.release': return finish(actor, input, 'release');
      case 'deliveries.ack': return finish(actor, input, 'ack');
      default: throw error(404, 'Unknown conversation operation.');
    }
  }
  return { execute };
}
