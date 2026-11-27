import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { ROOT_CONTEXT, SpanStatusCode, defaultTextMapGetter, defaultTextMapSetter, trace } from '@opentelemetry/api';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { TracerProvider, BatchSpanProcessor, ParentBasedSampler, RandomIdGenerator, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PutTraceSegmentsCommand, XRayClient } from '@aws-sdk/client-xray';

const operations = new Set([
  'company.command', 'company.admin_read', 'worker.work', 'worker.decision', 'work.process', 'work.failure',
  'model.decision', 'browser.read', 'tool.execute', 'factory.hire', 'factory.reconcile',
]);
const knownValues = new Set([
  'message', 'goal', 'task', 'review', 'owner', 'employee', 'system', 'ceo', 'factory', 'chat', 'inbox',
  'hire', 'fire', 'pause', 'resume', 'plan', 'create_goal', 'create_task', 'submit', 'progress', 'browse',
  'remember', 'recall', 'reply', 'wait', 'finish', 'work', 'blocked', 'create', 'send', 'assign', 'retry',
  'success', 'error', 'ok', 'accepted', 'denied', 'ready', 'working', 'done', 'failed', 'completed', 'open',
  'queued', 'pending', 'approved', 'changes_requested', 'submitted', 'cancelled', 'rejected', 'conflict',
  'mail','pass','search','open','start','stop','read','write','list','get','save','forget','approve','revoke',
  'allocate','propose','build','preview','release','rollback','commit','attach','snapshot','provision','status',
  'navigate','download','screenshot','input','review','close','confirm','active','stopped','expired','granted','revoked',
  'browser_connect','browser_connect_denied','browser_connect_http','browser_connect_network','browser_connect_filesystem',
  'browser_connect_protocol','browser_context','browser_page_origin','browser_action_protocol','browser_action',
  'decision_format', 'decision_provider', 'store', 'store_retry', 'store_access', 'aborted', 'other',
  'empty_response', 'invalid_json', 'invalid_action', 'invalid_value', 'invalid_target', 'invalid_delay',
]);
const commandNames = new Set([
  'conversations.list', 'conversations.dm', 'conversations.group', 'messages.list', 'messages.post', 'messages.status', 'messages.receipts',
  'inbox.claim', 'inbox.complete', 'inbox.release', 'goal.list', 'goal.get', 'goal.create', 'goal.close',
  'task.list', 'task.get', 'task.create', 'task.claim', 'task.progress', 'task.submit', 'task.review',
  'task.block', 'task.wait', 'task.resume', 'journal.get', 'journal.stage', 'journal.confirm', 'journal.fail',
  'admin.conversations', 'admin.messages', 'admin.events', 'admin.goals', 'admin.tasks',
  'directory.list', 'directory.get', 'employee.hire', 'employee.pause', 'employee.resume', 'employee.fire',
  'files.list','files.read','files.write','files.versions','files.part','files.commit','soul.get',
  'settings.effective','settings.get','settings.history','settings.update','settings.restore',
  'knowledge.list','knowledge.save','knowledge.forget','browser.list','browser.view','browser.start','browser.stop',
  'browser.takeover','browser.release','browser.profile.grant','browser.profile.revoke','browser.navigate','browser.input',
  'browser.document','browser.usage','browser.read','browser.frame','browser.screenshot','browser.download','governance.get','policy.get','policy.set',
  'promotion.list','promotion.propose','promotion.approve','grant.revoke','budget.get','budget.allocate','budget.reclaim',
  'budget.model.begin','budget.model.finish','project.create','project.list','project.get','project.history',
  'project.attach','project.commit','project.snapshot','delivery.build','delivery.preview','delivery.status',
  'delivery.release','delivery.rollback','delivery.withdraw','delivery.expire','infra.list','infra.provision','infra.status','infra.remove',
  'mail.list','mail.get','mail.claim','mail.finish','mail.release','mail.send','mail.reply','memory.save',
  'deliveries.claim','deliveries.ack','deliveries.stage','deliveries.release','activity.list','admin.activity',
  'memory.list', 'memory.remember', 'memory.update', 'memory.forget', 'worker.heartbeat',
]);
const idKeys = new Set(['work_id', 'agent_id', 'agentId', 'goalId', 'taskId', 'conversationId', 'messageId', 'commandId', 'workId']);
const domainIds = {projectId:/^p-[a-f0-9]{32}$/,jobId:/^j-[a-f0-9]{32}$/,buildId:/^b-[a-f0-9]{32}$/,
  resourceId:/^i-[a-f0-9]{32}$/,browserSessionId:/^bs-[a-f0-9]{32}$/,browserProfileId:/^bp-[a-f0-9]{32}$/};
const enumKeys = new Set(['work_kind', 'workKind', 'action', 'reason', 'outcome', 'status']);
const counts = new Set(['attempt', 'generation', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens']);
const identifier = /^(?:ceo|owner|[0-9a-f]{24,64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[acdegmtw]-[0-9a-f]{16,64})$/;
const releasePattern = /^[0-9a-f]{40,64}$/;
const scopePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[a-z][a-z0-9-]{0,30}$/;
const services = new Set(['resident', 'worker', 'api', 'factory', 'company', 'mail', 'local']);
const propagator = new W3CTraceContextPropagator();

function safeAttributes(attributes) {
  const safe = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (idKeys.has(key) && typeof value === 'string' && identifier.test(value)) safe[key] = value;
    else if (Object.hasOwn(domainIds,key) && typeof value==='string' && domainIds[key].test(value)) safe[key]=value;
    else if (key === 'command' && commandNames.has(value)) safe.command = value;
    else if (enumKeys.has(key) && knownValues.has(value)) safe[key] = value;
    else if (counts.has(key) && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) safe[key] = value;
    else if (key === 'model' && typeof value === 'string' && /^(?:us|global)\.openai\.gpt-[0-9]+(?:\.[0-9]+)?-(?:sol|astra|luna|terra)$/.test(value)) safe.model = value;
  }
  return safe;
}

// Only W3C traceparent crosses trusted internal boundaries. Baggage, tracestate and caller headers stay out.
function fromCarrier(carrier) {
  if (typeof carrier?.traceparent !== 'string' || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(carrier.traceparent)) return undefined;
  const context = propagator.extract(ROOT_CONTEXT, { traceparent: carrier.traceparent }, defaultTextMapGetter);
  return trace.getSpanContext(context) ? context : undefined;
}

const seconds = ([s, ns]) => s + ns / 1e9;
const xrayTraceId = id => '1-' + id.slice(0, 8) + '-' + id.slice(8);

export function createXRayExporter(client, report = () => {}) {
  let nextWarningAt = 0;
  function finish(callback, ok) {
    if (!ok && Date.now() >= nextWarningAt) {
      nextWarningAt = Date.now() + 60_000;
      try { report(); } catch { /* The export result remains independent of diagnostics. */ }
    }
    callback({ code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
  }
  return {
    export(spans, callback) {
      const documents = spans.map(span => {
        const service = span.resource.attributes['service.name'];
        const parent = span.parentSpanContext;
        const upstream = span.links[0]?.context;
        return JSON.stringify({
          name: service, id: span.spanContext().spanId, trace_id: xrayTraceId(span.spanContext().traceId),
          start_time: seconds(span.startTime), end_time: seconds(span.endTime),
          ...(parent && { parent_id: parent.spanId }), ...(parent && !parent.isRemote && { type: 'subsegment' }),
          ...(span.status.code === SpanStatusCode.ERROR && { fault: true }),
          annotations: { operation: span.name, scope: span.resource.attributes['perottino.scope'],
            ...(upstream && { upstream_trace_id: xrayTraceId(upstream.traceId) }) },
          metadata: { perottino: { ...span.attributes, release: span.resource.attributes['service.version'],
            links: span.links.map(({ context }) => ({ trace_id: xrayTraceId(context.traceId), span_id: context.spanId })) } },
        });
      });
      // Batches contain at most 25 short documents. The AWS SDK signs using the workload's own role.
      client.send(new PutTraceSegmentsCommand({ TraceSegmentDocuments: documents }), { abortSignal: AbortSignal.timeout(1500) })
        .then(response => finish(callback, !response.UnprocessedTraceSegments?.length), () => finish(callback, false));
    },
    async shutdown() { client.destroy?.(); },
  };
}

export function createTelemetry({ mode = 'off', service = 'local', scope = '', release = '', sampleRate = 1, endpoint,
  exporter, write = line => process.stdout.write(line + '\n') } = {}) {
  const storage = new AsyncLocalStorage();
  const name = services.has(service) ? service : 'local';
  const company = scopePattern.test(scope) ? scope : 'local';
  const version = releasePattern.test(release) ? release : undefined;
  const enabled = ['aws', 'otlp', 'test'].includes(mode);
  let provider;
  if (enabled) {
    const ids = new RandomIdGenerator();
    const resources = { 'service.name': name, 'perottino.scope': company, ...(version && { 'service.version': version }) };
    const exportWarning = () => write(JSON.stringify({ operation: 'telemetry.export_failed', service: name, scope: company }));
    const sink = exporter ?? (mode === 'aws' ? createXRayExporter(new XRayClient({ maxAttempts: 1 }), exportWarning)
      : new OTLPTraceExporter({ ...(endpoint && { url: endpoint }), timeoutMillis: 1500 }));
    provider = new TracerProvider({ resource: resourceFromAttributes(resources),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : 1) }),
      idGenerator: { generateSpanId: () => ids.generateSpanId(),
        generateTraceId: () => Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(12).toString('hex') },
      spanProcessors: [new BatchSpanProcessor({ exporter: sink, maxQueueSize: 256, maxExportBatchSize: 25, scheduledDelayMillis: 1000, exportTimeoutMillis: 2000 })],
    });
  }
  const tracer = provider?.getTracer('perottino');
  function traceCarrier() {
    const ctx = storage.getStore()?.context;
    if (!ctx) return undefined;
    const carrier = {};
    propagator.inject(ctx, carrier, defaultTextMapSetter);
    return carrier.traceparent ? { traceparent: carrier.traceparent } : undefined;
  }
  function emit(operation, attributes, elapsedMs, failed = false) {
    if (!enabled || !operations.has(operation)) return;
    const current = storage.getStore();
    const ctx = current && trace.getSpanContext(current.context);
    const record = { operation, service: name, scope: company, ...(version && { release: version }),
      ...(ctx && { traceId: ctx.traceId, spanId: ctx.spanId }),
      ...(current?.upstream && { upstreamTraceId: current.upstream.traceId, upstreamSpanId: current.upstream.spanId }),
      ...safeAttributes(attributes) };
    if (elapsedMs !== undefined) {
      record.DurationMs = elapsedMs;
      record.Operations = 1;
      record.Failures = failed ? 1 : 0;
    }
    if (mode === 'aws' && elapsedMs !== undefined) {
      const metrics = [{ Name: 'DurationMs', Unit: 'Milliseconds' }, { Name: 'Operations', Unit: 'Count' }, { Name: 'Failures', Unit: 'Count' }];
      for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens']) {
        if (record[field] !== undefined) metrics.push({ Name: field, Unit: 'Count' });
      }
      record._aws = { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'Perottino/Company',
        Dimensions: [['scope', 'service']], Metrics: metrics }] };
    }
    try { write(JSON.stringify(record)); } catch { /* Observation does not change the result of the work. */ }
  }
  function spanAttributes(attributes) {
    const current = storage.getStore();
    if (!current) return;
    const values = safeAttributes(attributes);
    Object.assign(current.attributes, values);
    current.span.setAttributes(values);
  }
  async function withSpan(operation, attributes, fn, options = {}) {
    if (!tracer || !operations.has(operation)) return fn();
    const values = safeAttributes(attributes);
    const parent = fromCarrier(options.parent) ?? storage.getStore()?.context ?? ROOT_CONTEXT;
    const links = (Array.isArray(options.links) ? options.links : []).slice(0, 4)
      .map(fromCarrier).filter(Boolean).map(ctx => ({ context: trace.getSpanContext(ctx) }));
    const span = tracer.startSpan(operation, { attributes: values, links }, parent);
    const start = performance.now();
    return storage.run({ span, context: trace.setSpan(parent, span), attributes: values, upstream: links[0]?.context }, async () => {
      let failed = false;
      try { return await fn(); }
      catch (error) { failed = true; span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
      finally {
        span.end();
        emit(operation, { ...values, outcome: failed ? 'error' : (values.outcome ?? 'success') }, Math.round(performance.now() - start), failed);
      }
    });
  }
  return { withSpan, traceCarrier, spanAttributes, operationEvent: emit,
    operationFailure(name, attributes, elapsedMs = 0) {
      const duration = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : 0;
      emit(name, { ...attributes, outcome: 'error' }, duration, true);
    },
    async flushTelemetry() { try { await provider?.forceFlush({ timeoutMillis: 2200 }); } catch { /* Best effort before Lambda freeze. */ } },
    async shutdown() { try { await provider?.shutdown(); } catch { /* Best effort on process shutdown. */ } } };
}

let shared;
function telemetry() {
  if (shared) return shared;
  try {
    shared = createTelemetry({ mode: process.env.PEROTTINO_TELEMETRY, service: process.env.PEROTTINO_SERVICE,
      scope: process.env.PEROTTINO_SCOPE, release: process.env.PEROTTINO_RELEASE,
      sampleRate: process.env.PEROTTINO_TRACE_SAMPLE_RATE === undefined ? 1 : Number(process.env.PEROTTINO_TRACE_SAMPLE_RATE),
      endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT });
  } catch { shared = createTelemetry(); }
  return shared;
}
export const withSpan = (...args) => telemetry().withSpan(...args);
export const traceCarrier = () => telemetry().traceCarrier();
export const spanAttributes = attributes => telemetry().spanAttributes(attributes);
export const operationEvent = (name, attributes) => telemetry().operationEvent(name, attributes);
export const flushTelemetry = () => telemetry().flushTelemetry();
export const operationFailure = (name, attributes, elapsedMs) => telemetry().operationFailure(name, attributes, elapsedMs);
