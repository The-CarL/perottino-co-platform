import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, QueryCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { hashPassword } from '../src/auth.mjs';
import { createCloudHandler } from '../src/cloud-api.mjs';
import { createCloudStore } from '../src/cloud-store.mjs';
import { executeCloudTurn, workerExit } from '../src/cloud-worker.mjs';
import { createDispatchHandlers } from '../src/dispatch.mjs';

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;

test('authenticated hosted messages pass through dispatch and a fresh worker, and survive duplicate delivery',
  { skip: !endpoint }, async t => {
    const url = new URL(endpoint);
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password, 'Use a loopback DynamoDB Local endpoint');
    const config = { endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
    const raw = new DynamoDBClient(config);
    const tableName = 'perottino-flow-' + randomUUID();
    await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
    }));
    const clients = [raw];
    t.after(async () => {
      try { await raw.send(new DeleteTableCommand({ TableName: tableName })); }
      finally { clients.forEach(client => client.destroy()); }
    });
    await waitUntilTableExists({ client: raw, maxWaitTime: 20, minDelay: 1, maxDelay: 2 }, { TableName: tableName });
    function freshStore() {
      const db = new DynamoDBClient(config);
      clients.push(db);
      return createCloudStore({ tableName, client: DynamoDBDocumentClient.from(db) });
    }

    const domain = 'company.example.test', origin = 'https://' + domain;
    const password = 'hosted-flow-test-fixture', username = 'owner';
    const verifier = { username, passwordHash: await hashPassword(password) };
    const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    function freshApi() {
      const api = createCloudHandler({ store: freshStore(), publicOrigin: origin, readOwner: async () => verifier });
      return async (section, body) => {
        const rawPath = '/api/agents/ceo/' + section, method = body ? 'POST' : 'GET';
        const res = await api({ version: '2.0', routeKey: '$default', rawPath, rawQueryString: '',
          headers: { authorization, host: domain, origin, 'content-type': 'application/json' },
          requestContext: { domainName: domain, requestId: randomUUID(), stage: '$default',
            http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp: '192.0.2.10' } },
          ...(body && { body: JSON.stringify(body), isBase64Encoded: false }),
        });
        assert.equal(res.statusCode, body ? 202 : 200, res.body);
        return JSON.parse(res.body);
      };
    }

    // Read the native AttributeValue row written by the real POST. Only the
    // Streams delivery envelope and the Standard workflow service are simulated.
    async function streamInsert(jobId) {
      const { Items } = await raw.send(new QueryCommand({ TableName: tableName, ConsistentRead: true,
        KeyConditionExpression: 'pk = :agent AND begins_with(sk, :pending)',
        ExpressionAttributeValues: { ':agent': { S: 'AGENT#ceo' }, ':pending': { S: 'PENDING#' } },
      }));
      const matches = Items.filter(item => item.jobId?.S === jobId);
      assert.equal(matches.length, 1, 'duplicate owner requests must produce one durable turn');
      const image = matches[0];
      assert.equal(image.state.S, 'queued');
      assert.equal(image.text, undefined, 'the dispatch record must not contain the owner message');
      return { Records: [{ eventSource: 'aws:dynamodb', eventName: 'INSERT',
        dynamodb: { SequenceNumber: image.seq.N, NewImage: image } }] };
    }

    const executions = new Map();
    const dispatcher = createDispatchHandlers({
      stateMachineArn: 'arn:aws:states:us-east-1:111111111111:stateMachine:fixture',
      getStore: freshStore, startExecution: async ({ name, input }) => {
        if (executions.has(name)) {
          assert.equal(executions.get(name), input);
          throw Object.assign(new Error('Replayed execution'), { name: 'ExecutionAlreadyExists' });
        }
        executions.set(name, input);
      },
    });
    async function deliver(envelope, jobId) {
      assert.deepEqual(await dispatcher.handler(envelope), { batchItemFailures: [] });
      const job = JSON.parse(executions.get('turn-' + jobId));
      assert.deepEqual(job, { agentId: 'ceo', jobId });
      const run = () => executeCloudTurn({ store: freshStore(), agentId: job.agentId, turnId: job.jobId,
        decide: () => assert.fail('Unexpected model invocation'), browse: () => assert.fail('Unexpected browser invocation') });
      assert.deepEqual(await dispatcher.admit(job), { status: 'ready' });
      assert.equal(await run(), workerExit.done);
      assert.deepEqual(await dispatcher.handler(envelope), { batchItemFailures: [] });
      assert.deepEqual(await dispatcher.admit(job), { status: 'done' });
      assert.equal(await run(), workerExit.done, 'a duplicate worker must not add another reply');
    }

    const firstApi = freshApi(), note = 'Use blue labels for the June release.';
    const remember = { text: 'remember ' + note, requestId: randomUUID() };
    const first = await firstApi('messages', remember);
    assert.deepEqual(await freshApi()('messages', remember), first);
    await deliver(await streamInsert(first.message.id), first.message.id);

    const followUpApi = freshApi(), recall = { text: 'recall blue labels', requestId: randomUUID() };
    const followUp = await followUpApi('messages', recall);
    await deliver(await streamInsert(followUp.message.id), followUp.message.id);
    assert.equal(executions.size, 2);

    const recovered = freshApi();
    const { messages } = await recovered('messages');
    assert.deepEqual(messages.map(({ author, text }) => [author, text]), [
      ['owner', remember.text], ['agent', 'Remembered: ' + note],
      ['owner', recall.text], ['agent', 'My saved notes:\n- ' + note],
    ]);
    const { memories } = await recovered('memory');
    assert.deepEqual(memories.map(({ text, sourceMessageId }) => [text, sourceMessageId]), [[note, first.message.id]]);
  });
