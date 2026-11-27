import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Only the factory roles can read this partition. Launch capabilities never enter DIRECTORY,
// inboxes, public employee responses, or an employee's workspace.
const key = sk => ({ pk: 'FACTORY#CONTROL', sk });
const contended = error => error.name === 'ConditionalCheckFailedException';

export function createFactoryState({ tableName = process.env.PEROTTINO_STATE_TABLE, client } = {}) {
  if (!tableName) throw new Error('Missing factory state table');
  const db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const get = async sk => (await db.send(new GetCommand({ TableName: tableName, Key: key(sk), ConsistentRead: true }))).Item;
  const gate = company => ({ Put: { TableName: tableName, Item: { pk: 'COMPANY#GATE', sk: 'STATE',
    running: company.enabled && !company.suspended, epoch: company.epoch, version: company.version } } });
  return {
    company: () => get('COMPANY'),
    async configure({ stackId, requestId, enabled, deployment, employeeLimit, residentLimit, create }) {
      for (let i = 0; i < 4; i++) {
        if (await get('CF#' + requestId)) return get('COMPANY');
        const old = await get('COMPANY');
        if (old && old.stackId !== stackId) {
          if (!enabled) return null; // A failed create cannot delete someone else's company.
          throw new Error('A different stack owns this company');
        }
        if (!create && enabled && !old?.enabled) throw new Error('Cannot update a disabled company');
        if (create && old && !old.enabled) throw new Error('Company shutdown is already committed');
        const company = { ...key('COMPANY'), stackId, version: (old?.version ?? 0) + 1, enabled, suspended: old?.suspended ?? false,
          epoch: (old?.epoch ?? 1) + Number(Boolean(old && old.enabled !== enabled)) };
        if (deployment ?? old?.deployment) company.deployment = deployment ?? old.deployment;
        if (employeeLimit ?? old?.employeeLimit) company.employeeLimit = employeeLimit ?? old.employeeLimit;
        const previousLimit = old?.residentLimit ?? old?.employeeLimit;
        const nextLimit = residentLimit ?? employeeLimit ?? previousLimit;
        if (nextLimit !== undefined) company.residentLimit = nextLimit;
        const reducingSeats = enabled && nextLimit < previousLimit;
        if (old?.cursor) company.cursor = old.cursor;
        try {
          await db.send(new TransactWriteCommand({ TransactItems: [
            { Put: { TableName: tableName, Item: company, ConditionExpression: old ? '#v=:v' : 'attribute_not_exists(pk)',
              ...(old && { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': old.version } }) } },
            { Put: { TableName: tableName, Item: { ...key('CF#' + requestId), stackId },
              ConditionExpression: 'attribute_not_exists(pk)' } },
            gate(company),
            ...(reducingSeats ? [{ ConditionCheck:{ TableName:tableName,Key:key('SEATS'),
              ConditionExpression:'attribute_not_exists(#n) OR #n<=:cap',ExpressionAttributeNames:{'#n':'occupied'},
              ExpressionAttributeValues:{':cap':nextLimit} } }] : []),
          ] }));
          return company;
        } catch (error) {
          if (error.name !== 'TransactionCanceledException') throw error;
          if (reducingSeats && error.CancellationReasons?.[3]?.Code === 'ConditionalCheckFailed')
            throw new Error('Release occupied Fargate slots before lowering the resident limit.');
        }
      }
      throw new Error('Concurrent company configuration change');
    },
    async suspend(requestId, suspended) {
      const receipt = key('OWNER#' + requestId);
      for (let i = 0; i < 4; i++) {
        const previous = await get(receipt.sk);
        if (previous) {
          if (previous.suspended !== suspended) throw Object.assign(new Error('Request conflict'), { status: 409 });
          return this.company();
        }
        const company = await this.company();
        if (!company?.enabled) throw Object.assign(new Error('No enabled company'), { status: 409 });
        const next = { ...company, suspended, version: company.version + 1, epoch: company.epoch + Number(company.suspended !== suspended) };
        try {
          await db.send(new TransactWriteCommand({ TransactItems: [
            { Update: { TableName: tableName, Key: key('COMPANY'), ConditionExpression: '#v=:old',
              UpdateExpression: 'SET suspended=:s, #v=:next, #e=:e', ExpressionAttributeNames: { '#v': 'version', '#e':'epoch' },
              ExpressionAttributeValues: { ':s': suspended, ':old': company.version, ':next': next.version, ':e':next.epoch } } },
            { Put: { TableName: tableName, Item: { ...receipt, suspended }, ConditionExpression: 'attribute_not_exists(pk)' } },
            gate(next),
          ] }));
          return this.company();
        } catch (error) { if (error.name !== 'TransactionCanceledException') throw error; }
      }
      throw new Error('Concurrent owner control change');
    },
    async advance(company, cursor) {
      try {
        await db.send(new UpdateCommand({ TableName: tableName, Key: key('COMPANY'), ConditionExpression: '#v=:v',
          UpdateExpression: cursor ? 'SET #c=:c' : 'REMOVE #c', ExpressionAttributeNames: { '#v': 'version', '#c': 'cursor' },
          ExpressionAttributeValues: { ':v': company.version, ...(cursor && { ':c': cursor }) } }));
      } catch (error) { if (!contended(error)) throw error; }
    },
    async run(id) { return (await get('RUN#' + id))?.run; },
    async runPage(cursor) {
      const rows = await db.send(new QueryCommand({ TableName: tableName, ConsistentRead: true, Limit: 50,
        KeyConditionExpression: 'pk=:pk AND begins_with(sk,:prefix)', ExpressionAttributeValues: { ':pk':'FACTORY#CONTROL', ':prefix':'RUN#' },
        ...(cursor && { ExclusiveStartKey:key(cursor) }) }));
      return { ids: (rows.Items ?? []).map(row => row.sk.slice(4)), cursor: rows.LastEvaluatedKey?.sk };
    },
    async waiters(limit) {
      const response = await db.send(new QueryCommand({TableName:tableName, ConsistentRead:true, Limit:limit,
        KeyConditionExpression:'pk=:pk AND begins_with(sk,:prefix)', ExpressionAttributeValues:{':pk':'FACTORY#CONTROL',':prefix':'WAIT#'}}));
      return (response.Items ?? []).map(row => ({id:row.sk.slice(5), generation:row.generation}));
    },
    async removeWaiter(id, generation) {
      try {
        await db.send(new DeleteCommand({TableName:tableName, Key:key('WAIT#'+id), ConditionExpression:'#g=:g',
          ExpressionAttributeNames:{'#g':'generation'}, ExpressionAttributeValues:{':g':generation}}));
      } catch (error) { if (!contended(error)) throw error; }
    },
    async lock(id, time) {
      const lease = randomUUID();
      try {
        const { Attributes } = await db.send(new UpdateCommand({ TableName: tableName, Key: key('RUN#' + id),
          ConditionExpression: 'attribute_not_exists(lockUntil) OR lockUntil <= :now',
          UpdateExpression: 'SET lockUntil=:end, lockOwner=:owner',
          ExpressionAttributeValues: { ':now': time, ':end': time + 90_000, ':owner': lease }, ReturnValues: 'ALL_NEW' }));
        return { lease, run: Attributes.run, seat: Attributes.seat === true };
      } catch (error) { if (contended(error)) return null; throw error; }
    },
    async save(id, lease, run, releaseSeat = false) {
      if (releaseSeat) {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Update:{ TableName:tableName, Key:key('RUN#'+id), ConditionExpression:'lockOwner=:owner AND seat=:yes',
            UpdateExpression:'SET #r=:r REMOVE seat', ExpressionAttributeNames:{'#r':'run'},
            ExpressionAttributeValues:{ ':owner':lease, ':r':run, ':yes':true } } },
          { Update:{ TableName:tableName, Key:key('SEATS'), ConditionExpression:'#n>:zero',
            UpdateExpression:'ADD #n :minus', ExpressionAttributeNames:{'#n':'occupied'},
            ExpressionAttributeValues:{ ':zero':0, ':minus':-1 } } },
        ] }));
        return;
      }
      await db.send(new UpdateCommand({ TableName: tableName, Key: key('RUN#' + id), ConditionExpression: 'lockOwner=:owner',
        UpdateExpression: 'SET #r=:r', ExpressionAttributeNames: { '#r': 'run' },
        ExpressionAttributeValues: { ':owner': lease, ':r': run } }));
    },
    async reserve(id, lease, run, company, seat, enqueue = true) {
      const seatCondition = seat ? 'seat=:yes' : 'attribute_not_exists(seat)';
      const limit = company.residentLimit ?? company.employeeLimit;
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName:tableName, Key:key('COMPANY'), ConditionExpression:'#v=:v AND #e=:yes AND #s=:no',
            ExpressionAttributeNames:{ '#v':'version', '#e':'enabled', '#s':'suspended' },
            ExpressionAttributeValues:{ ':v':company.version, ':yes':true, ':no':false } } },
          { Update: { TableName:tableName, Key:key('RUN#'+id), ConditionExpression:'lockOwner=:owner AND ' + seatCondition, UpdateExpression:'SET #r=:r, seat=:yes',
            ExpressionAttributeNames:{ '#r':'run' }, ExpressionAttributeValues:{ ':owner':lease, ':r':run, ':yes':true } } },
          ...(seat ? [] : [{ Update:{ TableName:tableName, Key:key('SEATS'), ConditionExpression:'attribute_not_exists(#n) OR #n<:limit',
            UpdateExpression:'ADD #n :one', ExpressionAttributeNames:{ '#n':'occupied' },
            ExpressionAttributeValues:{ ':limit':limit, ':one':1 } } }]),
          { Delete:{TableName:tableName,Key:key('WAIT#'+id)} },
        ] }));
        return true;
      } catch (error) {
        if (error.name !== 'TransactionCanceledException') throw error;
        const reasons = error.CancellationReasons ?? [];
        if (reasons.some(reason => !['None','ConditionalCheckFailed','TransactionConflict'].includes(reason.Code))) throw error;
        if (reasons.slice(0,2).some(reason => reason.Code === 'ConditionalCheckFailed')) return false;
        let full = !seat && reasons[2]?.Code === 'ConditionalCheckFailed';
        if (!reasons.length) {
          const [current,locked,seats] = await Promise.all([get('COMPANY'),get('RUN#'+id),get('SEATS')]);
          if (current?.version !== company.version || !current.enabled || current.suspended ||
              locked?.lockOwner !== lease || (locked.seat === true) !== seat) return false;
          full = !seat && seats?.occupied >= limit;
          if (!full) {
            if (enqueue) return this.reserve(id,lease,run,company,seat,false);
            throw error;
          }
        }
        if (!full || !enqueue) return false;
        try {
          await db.send(new UpdateCommand({TableName:tableName,Key:key('WAIT#'+id),
            UpdateExpression:'SET #g=:g',ConditionExpression:'attribute_not_exists(#g) OR #g<:g',
            ExpressionAttributeNames:{'#g':'generation'},ExpressionAttributeValues:{':g':run.generation}}));
        } catch (waitError) { if (contended(waitError)) return false; throw waitError; }
        // Close the interval between the first failed reservation and becoming
        // visible to the refill handler. Only a newly queued generation retries.
        return this.reserve(id,lease,run,company,seat,false);
      }
    },
    async unlock(id, lease, empty) {
      try {
        if (empty) {
          await db.send(new DeleteCommand({ TableName:tableName, Key:key('RUN#' + id), ConditionExpression:'lockOwner=:owner AND attribute_not_exists(seat)',
            ExpressionAttributeValues:{ ':owner':lease } }));
          return;
        }
        await db.send(new UpdateCommand({ TableName: tableName, Key: key('RUN#' + id), ConditionExpression: 'lockOwner=:owner',
          UpdateExpression: 'REMOVE lockUntil, lockOwner', ExpressionAttributeValues: { ':owner': lease } }));
      } catch (error) { if (!contended(error)) throw error; }
    },
  };
}
