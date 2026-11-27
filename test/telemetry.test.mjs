import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry, createXRayExporter } from '../src/telemetry.mjs';

const scope = '11111111-1111-4111-8111-111111111111-example';
const opaque = 'a'.repeat(64);
const secret = 'private email, receipt capability, full model output';

test('traceparent crosses an internal handoff, child spans nest, and retries can use new linked traces', async () => {
  const exporter = new InMemorySpanExporter(), logs = [];
  const t = createTelemetry({ mode: 'test', exporter, write: raw => logs.push(JSON.parse(raw)) });
  let carrier;
  await t.withSpan('company.command', { commandId: opaque }, async () => {
    carrier = t.traceCarrier();
    assert.match(carrier.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    await t.withSpan('tool.execute', { action: 'hire' }, async () => {});
  });
  assert.equal(t.traceCarrier(), undefined);
  await t.withSpan('work.process', { work_kind: 'message' }, async () => {}, { parent: { ...carrier, baggage: secret } });
  await t.withSpan('work.process', {}, async () => {}, { links: [carrier, undefined, { traceparent: secret }] });
  await t.flushTelemetry();
  const [child, enqueue, consumer, retry] = exporter.getFinishedSpans();
  assert.equal(child.parentSpanContext.spanId, enqueue.spanContext().spanId);
  assert.equal(consumer.parentSpanContext.spanId, enqueue.spanContext().spanId);
  assert.equal(consumer.parentSpanContext.isRemote, true);
  assert.equal(retry.links.length, 1);
  assert.equal(retry.links[0].context.traceId, enqueue.spanContext().traceId);
  assert.notEqual(retry.spanContext().traceId, enqueue.spanContext().traceId);
  assert.equal(logs.at(-1).upstreamTraceId, enqueue.spanContext().traceId);
  assert.equal(logs.at(-1).upstreamSpanId, enqueue.spanContext().spanId);
  assert.ok(!JSON.stringify(logs).includes(secret));
  await t.shutdown();
});

test('AWS exporter sends OTel spans to X-Ray and emits only approved attributes and low-cardinality EMF', async () => {
  const calls = [], logs = [];
  const client = { send: async cmd => { calls.push(cmd.input.TraceSegmentDocuments.map(JSON.parse)); return {}; } };
  const t = createTelemetry({ mode: 'aws', service: 'resident', scope, release: 'c'.repeat(40),
    exporter: createXRayExporter(client), write: raw => logs.push(JSON.parse(raw)) });
  const leaked = { work_id: opaque, agentId: secret, payload: secret, action: secret, reason: secret };
  await assert.rejects(t.withSpan('work.process', leaked, async () => {
    await t.withSpan('model.decision', { model: 'us.openai.gpt-6-sol' }, async () => {
      t.spanAttributes({ inputTokens: 30, outputTokens: 4, cachedInputTokens: -1 });
      throw new Error(secret);
    });
  }));
  await t.flushTelemetry();
  assert.ok(!JSON.stringify([calls, logs]).includes(secret));
  assert.equal(logs[0].inputTokens, 30);
  assert.equal(logs[0].cachedInputTokens, undefined);
  assert.equal(logs[0].Failures, 1);
  assert.deepEqual(logs[0]._aws.CloudWatchMetrics[0].Dimensions, [['scope', 'service']]);
  const [model, work] = calls.flat();
  assert.ok(model.fault && work.fault);
  assert.equal(model.type, 'subsegment');
  assert.equal(model.parent_id, work.id);
  assert.equal(model.annotations.operation, 'model.decision');
  assert.equal(model.metadata.perottino.outputTokens, 4);
  assert.match(work.trace_id, /^1-[a-f0-9]{8}-[a-f0-9]{24}$/);
  assert.equal(work.metadata.perottino.work_id, opaque);
  await t.shutdown();
});

test('idle operations, unexpected names and disabled local telemetry produce no telemetry', async () => {
  for (const mode of ['off', 'test']) {
    const exporter = new InMemorySpanExporter(), logs = [];
    const t = createTelemetry({ mode, exporter, write: raw => logs.push(raw) });
    const operation = mode === 'off' ? 'work.process' : 'worker.idle';
    assert.equal(await t.withSpan(operation, {}, () => 7), 7);
    t.operationEvent(operation, {});
    await t.flushTelemetry();
    assert.equal(logs.length, 0);
    assert.equal(exporter.getFinishedSpans().length, 0);
    await t.shutdown();
  }
});

test('the local OTLP exporter sends a redacted work span to a real HTTP receiver', async ctx => {
  const bodies = [], formats = [];
  const receiver = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    formats.push([req.url, req.headers['content-type']]);
    res.setHeader('content-type', req.headers['content-type']);
    res.end('{}');
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  ctx.after(() => { receiver.closeAllConnections(); return new Promise(resolve => receiver.close(resolve)); });
  const t = createTelemetry({ mode: 'otlp', endpoint: 'http://127.0.0.1:' + receiver.address().port + '/v1/traces', write() {} });
  await t.withSpan('work.process', { work_id: opaque, prompt: secret }, async () => {});
  await t.flushTelemetry();
  await t.shutdown();
  assert.equal(formats[0][0], '/v1/traces');
  assert.ok(bodies.some(body => body.includes('work.process') && body.includes(opaque)));
  assert.ok(bodies.every(body => !body.includes(secret)));
});

test('X-Ray rejection reports one content-free diagnostic and preserves application outcomes', async () => {
  const warnings = [];
  const exporter = createXRayExporter({ send: async () => { throw new Error(secret); } }, () => warnings.push('export_failed'));
  const t = createTelemetry({ mode:'aws', exporter, write() {} });
  for (let i = 0; i < 2; i++) {
    assert.equal(await t.withSpan('work.process', {}, async () => 17), 17);
    await t.flushTelemetry();
  }
  assert.deepEqual(warnings, ['export_failed']);
  await t.shutdown();
});

test('failures before a work span emit a bounded EMF failure without invoking trace export', async () => {
  const exporter = new InMemorySpanExporter(), lines = [];
  const t = createTelemetry({mode:'aws',service:'resident',scope,exporter,write:raw => lines.push(JSON.parse(raw))});
  t.operationFailure('work.failure',{ reason:'store_retry',attempt:2,secret,taskId:secret },45.2);
  await t.flushTelemetry();
  assert.equal(lines[0].Failures,1);
  assert.equal(lines[0].DurationMs,45);
  assert.equal(lines[0].outcome,'error');
  assert.equal(lines[0].attempt,2);
  assert.equal(lines[0].taskId,undefined);
  assert.equal(exporter.getFinishedSpans().length,0);
  await t.shutdown();
});
