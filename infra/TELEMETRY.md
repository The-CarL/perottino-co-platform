# Observing active company work

The hosted stack sends application OpenTelemetry spans to AWS X-Ray using signed `PutTraceSegments` calls under the workload role. A bounded in-process batch processor allows 256 queued spans and 25 per export. Set `traceSampleRate` in the private hosted configuration to a number between 0 and 1 to control the fraction of newly created traces recorded. Its default is 1. Workers and the broker emit telemetry for active operations. Empty work polls do not need a span. Lambda handlers flush the pending batch before returning.

Use the stack’s `OperationsDashboard` and `ResidentFailureAlarmName` outputs to locate the CloudWatch dashboard and alarm. The alarm counts three failed resident operations in five minutes. Nested failures can contribute individually. It records alarm state in CloudWatch. An operator can connect an approved notification destination. Amazon bills custom dashboards, metrics, alarms, logs and traces according to account usage. Sampling reduces trace exports. Structured operation logs and the metrics derived from them are independent of trace sampling.

The dashboard shows worker-reported token usage, failures, HTTP API errors and Lambda errors. Metrics under `Perottino/Company` use the project scope and service as dimensions. Token fields appear only when the native SDK returns usage. Token counts cover the SDK-reported turn and can include cached input. The dashboard provides an operational estimate. AWS billing records remain the source for actual charges.

In the project's 14-day CloudWatch log group, find a failed operation and use its trace ID to inspect related spans. Work that resumes in a fresh trace carries the previous trace and span IDs in the X-Ray segment’s `perottino.links` metadata when the producer supplied a link. Search CloudWatch Logs for `upstreamTraceId` or X-Ray for the `upstream_trace_id` annotation to locate downstream work from the producer. A rejected X-Ray export records a content-free warning at most once per minute per process. The authenticated company's durable events and retry receipts provide the history of committed operations. API Gateway access logs record the request ID, configured route, response status and latency.

```text
fields @timestamp, service, operation, outcome, reason, attempt, traceId, work_id
| filter outcome = "error" or operation = "work.failure"
| sort @timestamp desc
| limit 50
```

The application allowlists operation names, identifiers and reason codes. Company text, browser destinations, model output, caller headers, credential overrides and exception text stay out of application telemetry. Internal records may carry W3C `traceparent`. Only the trusted producer or its durable record supplies the parent or link. Keep logs and traces restricted to authorized operators because identifiers reveal relationships among employee activities.

## Local development

To send the same sanitized work spans to a developer-operated OTLP HTTP receiver, start the app with `PEROTTINO_TELEMETRY=otlp`, `PEROTTINO_SERVICE=local` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces`. Without an explicit telemetry mode, applications run locally without exporting. Run `node --test test/telemetry.test.mjs` to exercise W3C propagation, asynchronous links, export to a temporary receiver, dropped private fields, and quiet idle processing.
