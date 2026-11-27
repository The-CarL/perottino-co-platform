import { createEmployeeStore, firedError } from './employee-store.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const ceo = { id: 'ceo', name: 'Mara', handle: 'mara', role: 'CEO' };
const hash = text => createHash('sha256').update(text).digest('hex');
const agentPk = id => 'AGENT#' + id;
const ordinal = seq => String(seq).padStart(16, '0');
const turnKey = (pk, seq) => ({ pk, sk: 'TURN#' + ordinal(seq) });
const pendingKey = (pk, seq) => ({ pk, sk: 'PENDING#' + ordinal(seq) });
const metaKey = pk => ({ pk, sk: 'META' });
const lookupKey = (pk, id) => ({ pk, sk: 'REQUEST#' + id });
const noteKey = (pk, id, createdAt) => ({ pk, sk: 'NOTE#' + createdAt + '#' + id });
const noteIdKey = (pk, id) => ({ pk, sk: 'NOTE_ID#' + id });
const uniqueKey = (pk, text) => ({ pk, sk: 'NOTE_TEXT#' + hash(text) });

function publicAgent({ id, name, handle, role }) { return { id, name, handle, role }; }
function publicNote({ pk, sk, ...note }) { return note; }
function ownerMessage(turn) {
  return { id: turn.jobId, author: turn.author ?? 'owner', text: turn.text, createdAt: turn.createdAt,
    ...(turn.senderAgentId && { senderAgentId: turn.senderAgentId }), ...(turn.inReplyTo && {inReplyTo:turn.inReplyTo}), ...(turn.email && { sourceKind:'email', email:turn.email }) };
}
function transcript(turn) {
  const rows = [turn.state === 'error' ? { ...ownerMessage(turn), status: 'error' } : ownerMessage(turn)];
  if (turn.state === 'done') rows.push({ id: turn.replyId, author: 'agent', text: turn.reply, createdAt: turn.completedAt });
  return rows;
}

export function createCloudStore({ tableName = process.env.PEROTTINO_STATE_TABLE, client, now = Date.now, resident = process.env.PEROTTINO_RESIDENT === '1' } = {}) {
  if (!tableName) throw new Error('PEROTTINO_STATE_TABLE is required.');
  const ddb = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
  const get = async Key => (await ddb.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;
  const put = (Item, extra = {}) => ({ Put: { TableName: tableName, Item, ...extra } });
  const insert = Item => put(Item, { ConditionExpression: 'attribute_not_exists(pk)' });
  const remove = Key => ({ Delete: { TableName: tableName, Key } });
  const update = (Key, props) => ({ Update: { TableName: tableName, Key, ...props } });
  const revisionCheck = revision => ({
    ConditionExpression: 'memoryRevision = :r', ExpressionAttributeValues: { ':r': revision }
  });
  const bumpRevision = (pk, revision) => update(metaKey(pk), {
    ...revisionCheck(revision), UpdateExpression: 'ADD memoryRevision :one',
    ExpressionAttributeValues: { ':r': revision, ':one': 1 }
  });
  async function write(actions) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: actions }));
      return true;
    } catch (error) {
      if (error.name === 'TransactionConflictException') return false;
      if (error.name === 'TransactionCanceledException') {
        // Some service responses omit per-item reasons. Reconcile conditional writes
        // using fresh reads in that case; never swallow a reported validation or capacity error.
        const reasons = error.CancellationReasons ?? [];
        if (reasons.every(reason => ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code))) return false;
      }
      throw error;
    }
  }
  // Re-read the winning transaction on a conditional conflict. SDK backoff handles throttling.
  async function optimistic(operation) {
    for (let i = 0; i < 10; i++) {
      const result = await operation();
      if (result !== undefined) return result;
      await delay(Math.random() * Math.min(100, 4 * 2 ** i));
    }
    throw new Error('State changed repeatedly. Retry the same request.');
  }
  async function query(pk, prefix, { first = false, before, recent } = {}) {
    const params = { TableName: tableName, ConsistentRead: true,
      KeyConditionExpression: before ? 'pk=:pk AND sk BETWEEN :prefix AND :last' : 'pk=:pk AND begins_with(sk,:prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix, ...(before && { ':last': before }) },
      ...(first && { Limit: 1 }), ...(recent && { Limit: recent, ScanIndexForward: false })
    };
    const items = [];
    do {
      const page = await ddb.send(new QueryCommand(params));
      items.push(...(page.Items ?? []));
      params.ExclusiveStartKey = page.LastEvaluatedKey;
      if (first || (recent && items.length >= recent)) break;
    } while (params.ExclusiveStartKey);
    return recent ? items.slice(0, recent).reverse() : items;
  }

  let ready;
  function initialize() {
    if (resident) return; // The factory owns directory provisioning in the hosted resident deployment.
    ready ??= optimistic(async () => {
      const id = { pk: 'DIRECTORY', sk: agentPk(ceo.id) };
      if (await get(id)) return true;
      return await write([insert({ ...id, ...ceo }), insert({ ...metaKey(agentPk(ceo.id)), lastSequence: 0, memoryRevision: 0 })]) || undefined;
    }).catch(error => { ready = undefined; throw error; });
    return ready;
  }
  async function getAgent(id) {
    await initialize();
    const row = await get({ pk: 'DIRECTORY', sk: agentPk(id) });
    return row && publicAgent(row);
  }
  async function getMemories(agentId) {
    const items = await query(agentPk(agentId), 'NOTE#');
    return items.map(publicNote).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async function locate(agentId, jobId) {
    const pk = agentPk(agentId);
    const lookup = await get(lookupKey(pk, jobId));
    return lookup && await get(turnKey(pk, lookup.seq));
  }
  async function admission(turn, binding) {
    if (!turn || turn.state === 'error') return 'failed';
    if (turn.state === 'done') return 'done';
    const [head] = await query(turn.pk, 'PENDING#', { first: true });
    return head?.seq === turn.seq && (turn.state === 'queued' || turn.leaseUntil <= now() || (binding && turn.runArn && (turn.runArn !== binding.taskArn || turn.runGeneration !== binding.generation))) ? 'ready' : 'wait';
  }
  async function terminal(turn, token, binding) {
    const values = { ':error': 'error', ':working': 'working' };
    if (token) values[':token'] = token;
    else Object.assign(values, { ':queued': 'queued', ':now': now() });
    return write([...(binding ? [...people.gateChecks(),people.bindingCheck(binding)] : []),update(turnKey(turn.pk, turn.seq), {
      UpdateExpression: 'SET #s=:error REMOVE #t, leaseUntil',
      ConditionExpression: token ? '#s=:working AND #t=:token' : '#s=:queued OR (#s=:working AND leaseUntil<=:now)',
      ExpressionAttributeNames: { '#s': 'state', '#t': 'token' }, ExpressionAttributeValues: values
    }), remove(pendingKey(turn.pk, turn.seq))]);
  }
  async function publicStatus(pk, firstPage) {
    const [open] = await query(pk, 'PENDING#', { first: true });
    if (open) return open.state ?? 'queued';
    const latest = firstPage ? firstPage[0] : (await query(pk, 'TURN#', { recent: 1 }))[0];
    return latest && ['error', 'queued', 'working'].includes(latest.state) ? latest.state : 'idle';
  }
  function markPending(pk, seq, state) {
    return update(pendingKey(pk, seq), { UpdateExpression: 'SET #s=:s', ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':s': state } });
  }
  async function publicPage(agentId, prefix, limit, cursor, validCursor) {
    const pk = agentPk(agentId);
    if (cursor !== undefined && (typeof cursor !== 'string' || !validCursor.test(cursor)))
      throw new RangeError('Invalid page cursor.');
    const page = await ddb.send(new QueryCommand({ TableName: tableName, ConsistentRead: true,
      KeyConditionExpression: 'pk=:pk AND begins_with(sk,:prefix)', ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
      ScanIndexForward: false, Limit: limit, ...(cursor && { ExclusiveStartKey: { pk, sk: cursor } })
    }));
    return { items: page.Items ?? [], ...(page.LastEvaluatedKey && { nextCursor: page.LastEvaluatedKey.sk }) };
  }
  async function release(job, restoreAttempt = false) {
    if (resident && !job.binding) return false;
    if (job.goal) return people.checkpointGoal(job, { checkpoint:job.goal.checkpoint, status:'ready' }, false);
    const values = { ':q': 'queued', ':w': 'working', ':t': job.token };
    if (restoreAttempt) values[':one'] = 1;
    return write([update(turnKey(agentPk(job.agent.id), job.seq), {
      UpdateExpression: 'SET #s=:q' + (restoreAttempt ? ', attempts = attempts - :one' : '') + ' REMOVE #t, leaseUntil',
      ConditionExpression: '#s=:w AND #t=:t',
      ExpressionAttributeNames: { '#s': 'state', '#t': 'token' }, ExpressionAttributeValues: values
    }), markPending(agentPk(job.agent.id), job.seq, 'queued'), ...(job.binding ? [...people.gateChecks(), people.bindingCheck(job.binding), people.unlockWork(job)] : [])]);
  }

  async function getHistory(id) {
    const rows = await query(agentPk(id), 'TURN#', { recent:16 });
    return rows.filter(turn => turn.author !== 'external').flatMap(transcript).slice(-16);
  }
  const people = createEmployeeStore({ ddb, tableName, get, query, write, insert, put, remove, update, optimistic, now, getMemories, getHistory });
  async function enqueue(agentId, text, requestId, source = {}) {
      if (!await getAgent(agentId)) throw new Error('Unknown agent.');
      const pk = agentPk(agentId);
      const jobId = hash(agentId + '\0' + (source.author ? source.author + '\0' : '') + requestId);
      const lookup = lookupKey(pk, jobId);
      return optimistic(async () => {
        const existing = await locate(agentId, jobId);
        if (existing) {
          // SES can deliver the same message separately to two aliases of one employee.
          // Keep the original envelope recipient while validating the sender, subject and body.
          const differentEmail = source.email && ['messageId', 'from', 'subject'].some(key => existing.email?.[key] !== source.email[key]);
          return { conflict: existing.text !== text || existing.inReplyTo !== source.inReplyTo || Boolean(differentEmail),
            message: ownerMessage(existing), turnId: jobId };
        }
        const target = await people.employee(agentId);
        if (target.desiredState === 'fired') throw firedError();
        if (source.binding) {
          const sender = await people.employee(source.binding.agentId);
          if (sender?.desiredState !== 'active' || sender?.generation !== source.binding.generation || sender?.taskArn !== source.binding.taskArn)
            throw Object.assign(new Error('Sender binding is inactive.'), { status:403 });
        }
        const meta = await get(metaKey(pk));
        const seq = meta.lastSequence + 1;
        const turn = { ...turnKey(pk, seq), kind: 'turn', agentId, jobId, text, seq, state: 'queued', attempts: 0,
          createdAt: new Date(now()).toISOString(), ...(source.author && {author:source.author}),
          ...(source.senderAgentId && {senderAgentId:source.senderAgentId}), ...(source.inReplyTo && {inReplyTo:source.inReplyTo}), ...(source.email && {email:source.email}) };
        const guards = source.binding ? [...people.gateChecks(), people.bindingCheck(source.binding)] : [];
        if (!source.binding || source.binding.agentId !== agentId) guards.push(people.accepting(agentId));
        const saved = await write([...guards, insert(turn), insert({ ...lookup, seq }),
          insert({ ...pendingKey(pk, seq), kind: 'job', agentId, jobId, seq, state: 'queued' }),
          update(metaKey(pk), { UpdateExpression: 'SET lastSequence=:next', ConditionExpression: 'lastSequence=:old',
            ExpressionAttributeValues: { ':next': seq, ':old': meta.lastSequence } })]);
        if (saved) return { conflict: false, message: ownerMessage(turn), turnId: jobId };
      });
    }
  async function enqueueEmail(agentId, { messageId, from, to, subject, text }) {
    if (![messageId,from,to,subject,text].every(x => typeof x === 'string') || !messageId || !from || !to ||
        messageId.length > 1000 || from.length > 500 || to.length > 500 || subject.length > 1000 || text.length > 16000)
      throw new RangeError('Invalid inbound email.');
    return enqueue(agentId,text,'email:' + messageId,{ author:'external', email:{messageId,from,to,subject} });
  }
  async function sendFromResident(binding, agentId, text, requestId, {inReplyTo} = {}) {
    if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !inReplyTo || inReplyTo.length > 160)) throw new RangeError('Invalid reply reference.');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000 || typeof requestId !== 'string' || !requestId || requestId.length>160) throw new RangeError('Invalid employee message.');
    return enqueue(agentId,text,'employee:'+binding.agentId+':'+requestId, {author:'employee',senderAgentId:binding.agentId,binding,inReplyTo});
  }
  const api = {
    async directory() { await initialize(); return (await query('DIRECTORY', 'AGENT#')).map(publicAgent); },
    getAgent, getMemories,
    close() { if (!client) ddb.destroy(); },
    async messagePage(agentId, cursor) {
      const page = await publicPage(agentId, 'TURN#', 10, cursor, /^TURN#\d{16}$/);
      const status = await publicStatus(agentPk(agentId), cursor ? undefined : page.items);
      const { items, ...continuation } = page;
      return { messages: items.reverse().flatMap(transcript), status, ...continuation,
        ...(status === 'error' && { error: 'The agent could not complete the last turn. You can send it again.' }) };
    },
    async memoryPage(agentId, cursor) {
      const { items, ...continuation } = await publicPage(agentId, 'NOTE#', 20, cursor,
        /^NOTE#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[a-zA-Z0-9_-]{1,160}$/);
      return { memories: items.map(publicNote), ...continuation };
    },
    async messageSource(agentId, id) {
      if (!/^[a-f0-9]{64}$/.test(id)) return null;
      const turn = await locate(agentId, id);
      return turn ? ownerMessage(turn) : null;
    },
    async messages(agentId) {
      const turns = await query(agentPk(agentId), 'TURN#');
      let status = 'idle';
      if (turns.some(t => t.state === 'working')) status = 'working';
      else if (turns.some(t => t.state === 'queued')) status = 'queued';
      else if (turns.at(-1)?.state === 'error') status = 'error';
      return { messages: turns.flatMap(transcript), status,
        ...(status === 'error' && { error: 'The agent could not complete the last turn. You can send it again.' }) };
    },
    enqueue: (id,content,requestId) => enqueue(id,content,requestId), enqueueEmail, sendFromResident,
    async turnAdmission(agentId, jobId) { return admission(await locate(agentId, jobId)); },
    async claimTurn(agentId, jobId, leaseMs, binding) {
      if (resident && !binding) return {state:'inactive'};
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Invalid turn lease.');
      const turn = await locate(agentId, jobId);
      if (!turn) return { state: 'missing' };
      if (['done', 'error'].includes(turn.state)) return { state: turn.state };
      if (await admission(turn,binding) !== 'ready') return { state: 'busy' };
      if (turn.attempts >= 3) {
        const settled = await terminal(turn, turn.token,binding);
        return { state: settled ? 'error' : 'busy' };
      }
      const pk = turn.pk;
      const time = now();
      const token = randomUUID();
      const replaced = binding ? ' OR (attribute_exists(runArn) AND (runArn<>:arn OR runGeneration<>:gen))' : '';
      const acquired = await write([...(binding ? people.lockWork(binding, token, leaseMs) : []), update(turnKey(pk, turn.seq), {
        UpdateExpression: 'SET #s=:w, #t=:t, leaseUntil=:until' + (binding ? ', runArn=:arn, runGeneration=:gen' : '') + ' ADD attempts :one',
        ConditionExpression: 'attempts=:attempts AND (#s=:q OR (#s=:w AND (leaseUntil<=:now' + replaced + ')))',
        ExpressionAttributeNames: { '#s': 'state', '#t': 'token' },
        ExpressionAttributeValues: { ':w': 'working', ':q': 'queued', ':t': token, ':until': time + leaseMs,
          ':one': 1, ':attempts': turn.attempts, ':now': time, ...(binding && {':arn':binding.taskArn, ':gen':binding.generation}) }
      }), markPending(pk, turn.seq, 'working')]);
      if (!acquired) return { state: 'busy' };
      // Read the revision before loading notes. Completion checks it in the same transaction as the reply.
      const meta = await get(metaKey(pk));
      const [agent, memories, prior] = await Promise.all([
        people.employee(agentId), getMemories(agentId),
        turn.seq > 1 ? query(pk, 'TURN#', { before: turnKey(pk, turn.seq - 1).sk, recent: 16 }) : []
      ]);
      return { state: 'claimed', job: { token, seq: turn.seq, agent: binding ? agent : publicAgent(agent), ...(binding && {binding}), message: ownerMessage(turn),
        history: prior.filter(t=>t.author !== 'external').flatMap(transcript).slice(-16), memories, memoryRevision: meta.memoryRevision } };
    },
    async complete(job, reply, pendingNotes = [], newGoal) {
      if (resident && !job.binding) return false;
      if (newGoal && job.message.author === 'external') throw Object.assign(new Error('External email cannot assign company work.'),{status:403});
      const pk = agentPk(job.agent.id);
      const rows = [];
      const texts = new Set(job.memories.map(m => m.text));
      for (const candidate of pendingNotes) {
        if (texts.has(candidate.text)) continue;
        texts.add(candidate.text);
        rows.push({ id: candidate.id, text: candidate.text, createdAt: candidate.createdAt, sourceMessageId: job.message.id });
      }
      if (rows.length > Math.min(32, Math.floor((100 - 3 - Number(!!job.binding) - (job.binding ? people.gateChecks().length : 0) - (newGoal ? 3 : 0)) / 3))) throw new Error('Too many notes for one turn.');
      const actions = [update(turnKey(pk, job.seq), {
        UpdateExpression: 'SET #s=:done, replyId=:id, reply=:reply, completedAt=:at REMOVE #t, leaseUntil',
        ConditionExpression: '#s=:w AND #t=:t AND leaseUntil>:now',
        ExpressionAttributeNames: { '#s': 'state', '#t': 'token' },
        ExpressionAttributeValues: { ':done': 'done', ':id': randomUUID(), ':reply': reply, ':at': new Date(now()).toISOString(),
          ':w': 'working', ':t': job.token, ':now': now() }
      }), remove(pendingKey(pk, job.seq))];
      if (newGoal) actions.push(...people.goalItems(job.agent.id, job.message.id, newGoal.text, newGoal.checkpoint ?? '', newGoal.nextRunAt ?? now(), 'message').actions);
      if (job.binding) actions.push(...people.gateChecks(),people.bindingCheck(job.binding), people.unlockWork(job, job.memoryRevision, rows.length > 0));
      else if (rows.length) actions.push(bumpRevision(pk, job.memoryRevision));
      else actions.push({ ConditionCheck: { TableName: tableName, Key: metaKey(pk), ...revisionCheck(job.memoryRevision) } });
      for (const row of rows) {
        const key = noteKey(pk, row.id, row.createdAt);
        actions.push(insert({ ...key, ...row }), insert({ ...noteIdKey(pk, row.id), noteSk: key.sk }),
          insert({ ...uniqueKey(pk, row.text), id: row.id }));
      }
      if (await write(actions)) return true;
      if ((await get(metaKey(pk))).memoryRevision !== job.memoryRevision) await release(job, true);
      return false;
    },
    release,
    async fail(job) {
      if (resident && !job.binding) return false;
      if (job.goal) return people.checkpointGoal(job, { checkpoint:job.goal.checkpoint, status:'blocked' }, false);
      if (job.binding) return write([...people.gateChecks(),people.bindingCheck(job.binding), people.unlockWork(job),
        update(turnKey(agentPk(job.agent.id),job.seq),{ UpdateExpression:'SET #s=:err REMOVE #t,leaseUntil', ConditionExpression:'#t=:tok',
          ExpressionAttributeNames:{'#s':'state','#t':'token'}, ExpressionAttributeValues:{':err':'error',':tok':job.token} }), remove(pendingKey(agentPk(job.agent.id),job.seq))]);
      return terminal({ pk: agentPk(job.agent.id), seq: job.seq }, job.token); },
    async finishTurnWithError(agentId, jobId) {
      if (resident) throw Object.assign(new Error('Only a bound resident can end its turn.'),{status:403});
      return optimistic(async () => {
        const turn = await locate(agentId, jobId);
        if (!turn || turn.state === 'error') return { status: 'failed' };
        if (turn.state === 'done') return { status: 'done' };
        if (turn.state === 'working' && turn.leaseUntil > now()) return { status: 'active' };
        if (await terminal(turn)) return { status: 'failed' };
      });
    },
    async changeMemory(agentId, id, method, requestId, text = '') {
      if (!['PATCH', 'DELETE'].includes(method)) throw new Error('Unknown memory action.');
      const pk = agentPk(agentId);
      const indexKey = noteIdKey(pk, id);
      const receiptKey = { pk, sk: 'MUTATION#' + hash(requestId) };
      const signature = hash(JSON.stringify([id, method, text]));
      async function recordedResult() {
        const receipt = await get(receiptKey);
        if (receipt) return receipt.signature === signature ? 'ok' : 'conflict';
      }
      return optimistic(async () => {
        const recorded = await recordedResult();
        if (recorded) return recorded;
        const meta = await get(metaKey(pk));
        const byId = await get(indexKey);
        const key = byId && { pk, sk: byId.noteSk };
        const note = key && await get(key);
        // A concurrent edit/delete can commit after the initial receipt read.
        if (!note) return (await recordedResult()) ?? 'missing';
        const at = new Date(now()).toISOString();
        const actions = [insert({ ...receiptKey, signature, sourceMessageId: note.sourceMessageId, createdAt: at }),
          bumpRevision(pk, meta.memoryRevision)];
        if (method === 'DELETE') actions.push(remove(key), remove(indexKey), remove(uniqueKey(pk, note.text)));
        else {
          if (text !== note.text) {
            const holder = await get(uniqueKey(pk, text));
            if (holder) {
              const result = await recordedResult();
              // If this note already acquired the text using a different request, read its
              // current version before recording our own successful, no-change edit.
              return result ?? (holder.id === id ? undefined : 'duplicate');
            }
            actions.push(remove(uniqueKey(pk, note.text)), insert({ ...uniqueKey(pk, text), id }));
          }
          actions.push(put({ ...note, text, updatedAt: at, updatedBy: 'owner' }));
        }
        if (await write(actions)) return 'ok';
      });
    }
  };
  const { accepting, bindingCheck, gateChecks, lockWork, unlockWork, goalItems, claimGoal, ...employeeApi } = people;
  return { ...api, ...employeeApi, async claimNextWork({ agentId, generation, taskArn, leaseMs }) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(generation) || !taskArn) throw new RangeError('Invalid resident claim.');
    const binding = { agentId, generation, taskArn };
    const person = await people.employee(agentId);
    if (person?.desiredState !== 'active' || person.generation !== generation || (person.taskArn && (person.taskArn !== taskArn || person.taskGeneration !== generation))) return {state:'inactive'};
    if (!person.taskArn) return {state:'busy'};
    const control = await get(metaKey(agentPk(agentId)));
    if (control.activeArn === taskArn && control.activeGeneration === generation && control.activeUntil > now()) return {state:'busy'};
    const [head] = await query(agentPk(agentId),'PENDING#',{first:true});
    if (head) {
      const id = head.jobId ?? (await get(turnKey(agentPk(agentId),head.seq)))?.jobId;
      const claimed = await api.claimTurn(agentId,id,leaseMs,binding);
      return claimed.state==='claimed' ? {...claimed,kind:'message'} : {state:'busy'};
    }
    return people.claimGoal(binding, leaseMs, control.lastSequence);
  } };
}
