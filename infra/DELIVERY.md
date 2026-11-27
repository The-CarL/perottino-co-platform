# Building and delivering a project

The trusted broker reads an immutable Git handoff, runs its JavaScript in an isolated executor, and publishes the successful public files on a dedicated HTTP origin. A second installation, the optional sandbox provisioner, creates temporary AWS resources in the account the owner designates.

## Static application template

`static-site-v1` accepts a project snapshot of up to 64 UTF-8 files and 64 KiB total. Include `public/index.html` and synchronous `test/*.test.mjs` or `test/*.test.js` tests. The public tree can contain HTML, CSS, JavaScript modules, JSON, CSV, text and SVG. Only files under `public/` are published. Imports can refer to relative JavaScript or JSON files in the snapshot.

An optional `build.mjs` exports a synchronous default function returning an array of generated `{path,content}` public files. It can import source and data from the committed snapshot. The executor compiles these files before the tests, so the tests can import the generated modules. The testing interface supports synchronous `test(name,fn)`, `ok`, `strictEqual` and structural equality of JSON objects and arrays using `deepStrictEqual`. These are a small dependency-free subset of the Node test and assert interfaces. For example, a test of a generated public-data app might contain

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fahrenheit } from '../public/forecast.mjs';

test('freezing point', () => assert.strictEqual(fahrenheit(0), 32));
```

A successful build needs at least one passing test. Validation stores a source SHA, task ID, build ID, outcome, test count and bounded reason code. A failing assertion prevents publication. Application code runs inside a fresh, 16 MiB QuickJS WebAssembly runtime with a 1.8-second deadline. Its module loader resolves only the committed files and approved test helpers. It has no filesystem, network, subprocess, environment or AWS SDK bindings. The hosted executor is a separate six-second Lambda. Its AWS role can write execution logs only. The local executor runs the same compiler in a non-root Docker container with a read-only root, no network, dropped capabilities, a process limit, 0.5 CPU and 128 MiB of memory. The Docker context uses the platform's pinned lockfile and Node image.

In the broker, `delivery.build` accepts `{projectId, taskId, commitSha, requestId}`. The server resolves the current actor's access to the specific project and committed task. Generated source and raw test output stay out of traces and metrics. Returning a completed build for the same snapshot costs no new execution. A new dispatch reserves and settles one internal policy cent against the builder's ledger before invocation. This conservative admission price includes attempts with an unknown transport result. Actual AWS charges appear in the account bill. A 25-second lease exceeds the hosted executor's hard timeout. Partial budget admission resumes under its stable attempt ID. Retrying an ambiguous dispatched execution requires fresh budget and quota. The default ceilings are 32 company dispatches per UTC day, 64 stored builds per project, and eight active preview projects. The operator can lower these ceilings in the delivery policy.

## Preview and production

| Operation | Required input in addition to projectId | Effect |
| --- | --- | --- |
| delivery.status | taskId, commitSha | Returns the tested handoff and the project's current preview and production addresses. |
| delivery.preview | buildId, requestId, optional ttlHours | Publishes the passed build for up to 168 hours. A project has one current preview. Default lifetime is 24 hours. |
| delivery.release | buildId, requestId | Switches the stable production address to that tested build and remembers its predecessor. |
| delivery.rollback | requestId | Switches production back to the previous tested build. A retried request cannot alternate the release twice. |
| delivery.withdraw | current buildId, requestId | Removes the production publication when the owner supplies the reviewed current build ID. |
| delivery.expire | current buildId, requestId | Removes the reviewed preview immediately under owner authority. |

Production release and rollback default to the owner. `deliveryPolicy.productionAgents` can grant a named employee those routine operations for one exact project ID. Withdrawal still requires the owner. Conditional transactions update public contents, idempotency receipts and audit history together. Preview reads check expiry on **every** request. The five-minute company repair also removes expired public copies. Build evidence remains in the private company table for handoff and rollback. Issuing a new request for an old passed build can republish it under a new preview lifetime.

The separate AWS HTTP API serves GET and HEAD from a Lambda limited to two public DynamoDB partitions. The public reader has no transcript, Git, deployment, IAM or owner-secret access. API throttling, CSP sandboxing, blocked worker and form execution, no-store responses and origin isolation apply to every site. Published JavaScript runs as browser code in an opaque origin. Persist application data in its approved backend when a subsequent template supports that capability. Review and extend templates, build dependencies and infrastructure grants through the privileged infrastructure repository workflow.

To run the normal local build and the packaged acceptance tests from the repository root

```sh
docker build -f Dockerfile.delivery -t perottino-delivery:local .
PEROTTINO_DELIVERY_TEST_IMAGE=perottino-delivery:local node test/company-deployments.test.mjs
```

Use `PEROTTINO_UI_DELIVERY=1` with installed Playwright Chromium to run the browser module check. The normal local app stores the separate preview listener port in its data directory so published links survive a restart. A fixed local port can be supplied with `PEROTTINO_DELIVERY_PORT`.

## Optional sandbox account

The `temporary-queue-v1` template creates a real private **standard SQS queue** in the chosen sandbox region. Eight physical queue names in the company's namespace bound the installation's resource count, even during concurrent provisioning. Queues use SQS-managed encryption, one-hour message retention, a 64 KiB maximum message and a 30-second visibility timeout. Queue URLs require IAM credentials with data-plane authority. The broker, employee and provisioner roles receive no queue read-message or send-message grants from this feature. If an external consumer is authorized separately, scope that grant to the specific queue ARN **and** the `perottino:resource` tag of this generation. Physical slots can be reused.

1. Deploy the company stack without a sandbox target. Record its `HostedBrokerRoleArn` output and project scope. The AWS owner chooses the target account and region, which may be separate from the company account.
2. Put the reviewed platform Lambda image into target-region ECR, verify the digest, and give the Lambda service permission to retrieve that repository image for the target function `factory-<scope>-r-z`. Supply the target account's reviewed permissions boundary and the project's normal provenance tags. The sandbox stack never copies credentials or assumes a role in the company account.
3. Review [sandbox-queues.yaml](sandbox-queues.yaml) and its change set in the selected target account. The stack inputs are `ProjectScope`, `BrokerRoleArn`, `SandboxPermissionsBoundaryArn`, `LambdaImageUri` and `QueueProvenance` (a JSON map of the project's reviewed factory tags). Apply the normal factory creation/run provenance tags to the stack as well. Its Lambda reads only ownership and configuration for those eight queue names, can create only tagged slots and delete only slots carrying both the expected company scope and template purpose. The target owns its own seven-day logs.
4. Configure the company stack's `sandboxProvisioner` from the target's `ApiId`, `ApiRegion` and `ApiAccount` outputs. The company broker signs a single `POST /sandbox/resources` route using its own AWS credentials. The target regional REST API requires AWS IAM and denies other principals. The source role is granted `execute-api:Invoke` on exactly this stage, verb, endpoint and target account. Verify the effective source and target role boundaries and any account-level SCPs permit that specific operation. Create a sacrificial short-lived queue and verify its attributes, tags, expiry and final absence in the designated account before accepting hosted provisioning.

Actors with project access can use `infra.provision({projectId,template:'temporary-queue-v1',ttlHours,requestId})`, `infra.list({projectId})`, and `infra.status({projectId,resourceId})`. The default lifetime is 24 hours, with a range of 1–168 hours. Only the owner can request early destruction using `infra.remove({projectId,resourceId,requestId})`. Deleting a queue discards its pending messages. A project-scoped intent and slot are saved before contacting the target. Replays check the durable identity, tags and attributes. A mismatched existing queue or generation is never adopted or removed. During SQS's name-reuse cooldown the company can retry the original request. RPC errors preserve the original intent. Work is marked removed only after the target confirms absence or a different generation owns that slot.

Every 15 minutes the independent sandbox sweeper checks the eight exact slots and deletes expired owned queues, including if the company stack is offline. Provisioning creates no NAT, resident container or queue consumer. API, SQS control requests, scheduled Lambda runs, logs and queue data-plane traffic are billed by AWS. A company repair reconciles expiry back to its directory. Before removing the sandbox installation, expire or remove every queue, verify terminal absence in the target, and then retire the API, schedule, project roles and logs through the approved teardown. Removing the sandbox control stack first would remove its independent sweeper.

The local adapter creates the queue namespace in separate private SQLite files, preserves queue data across restarts, and clears it on expiry or removal. `node test/company-infrastructure.test.mjs` verifies resource allocation, foreign-resource protection, quota contention, expiry, SDK command parameters and SigV4 request signing. Local verification does not exercise AWS IAM, service quotas, the image pull policy or live SQS eventual consistency.
