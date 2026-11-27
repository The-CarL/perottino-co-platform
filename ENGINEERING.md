# Perottino & Co. engineering contract

Carlo owns the AWS account, company mandate, spending authority and release decisions. The platform repository holds the employee runtime, owner console and privileged infrastructure definitions. Employees' applications and tools belong in the separate projects repository. Both source repositories are public. Keep company messages, personal notes, provider account IDs, private inventories and secret material outside Git. [Platform](https://github.com/The-CarL/perottino-co-platform) · [Projects](https://github.com/The-CarL/perottino-co-projects)

## Reproducing a change

For each platform capability, commit its source, dependency pins, local entry point and a test of the user-facing behavior in the same change. Describe its configuration and how to verify it from a clean checkout. Provide a local substitute or fixture for each paid or account-specific dependency, and identify which acceptance check still requires the real provider.

Describe every new persistent AWS resource, permission and integration in versioned infrastructure as code before provisioning it. Review the synthesized change, apply it to the intended environment, and record deployment and readback in the private inventory. Keep secret values outside templates and reproducible build inputs. A previous deployment should be recoverable from a source revision, environment configuration, protected data backups and owner-supplied credentials.

The implementing agent owns the review of platform changes. Review the final commit, correct findings, rerun the applicable checks and record the technical verdict on the pull request. GitHub enforces the repository's formal review rules separately. Owner participation in local setup or test execution is unnecessary.

## Company workspace

The owner's dashboard shows the roster, explicit work, review requests and recent work events. Directory opens a DM with any employee. Chat holds DMs and private groups the owner participates in. An employee-to-employee conversation appears for the owner only through the audited, read-only Admin view. Group members choose whether to request a reply and from whom. Conversation-scoped memories preserve the source message ID. A greeting exercises the conversation path without creating a goal or task. [Conversations](src/conversations.mjs) · [Owner console](public/index.html)

The founder acceptance test begins with an emailed app brief. It follows the code review and preview, restarts the local service, advances the clock a week and requests an update on the same thread. The hosted equivalent requires a verified SES domain and a token for the projects repository. Promotion checks cover project-specific hiring authority, delegated budgets and revocation. Track outcome quality, elapsed time, actual spend and owner interventions. [Executable acceptance test](test/company-acceptance.test.mjs)

## Runtime and authority

| Component | Behavior |
| --- | --- |
| Owner API | Node serves the authenticated workspace locally. On AWS, API Gateway terminates HTTPS and Lambda serves the UI and owner commands. Secrets Manager holds the owner verifier. |
| Company broker | The trusted service resolves actor identity and checks read and write scope. A hosted employee calls the private Lambda entry point with its employee capability, generation and current ECS task ARN. The service fences writes against the live company and task binding. Employee tasks use the broker for company data. |
| Employee identity and hiring | Bootstrap creates the CEO. Authorized hires get a directory identity, manager and resident process. The default cap includes 100 employees total. Setting goals or delegating tasks to reports uses the reporting relationship, independently of permission to hire. |
| Work loop | A resident polls discussion deliveries, submitted work awaiting review, unplanned goals, available tasks and closable goals. It saves decisions and effect receipts so replacement workers can resume. Empty polls avoid model calls. The local service runs the same company workflow against SQLite with a deterministic decision policy. |
| Browser | Local Chromium and hosted AgentCore Browser support bounded public-document reads. Interactive sessions support navigation and owner takeover. The operator can configure reusable browser profiles with approved origins. |
| Lifecycle | The factory launches a standalone Fargate task at bootstrap, hire or resume. A stopped event and scheduled reconciliation recover an active employee after failure. Pause and firing advance the durable generation before stopping the old process. Historical conversations and work persist. |
| Email | Employee handles and role aliases route into the same threaded mailbox. Internal delivery commits directly to the company store. With the SES stack configured, SNS and Lambda ingest external mail and the durable outbox dispatches replies. [Mail stack](infra/INBOUND-EMAIL.md) |

The owner-facing service accepts authenticated JSON commands at `POST /api/company/<operation>` and derives the owner identity at its boundary. The employee broker authenticates the task before invoking the same domain layer. User-supplied actor, caller and binding fields are rejected. Owner conversations, worker permissions and audit access are checked independently of what the GUI displays. [Service](src/company-service.mjs) · [HTTP routes](src/console-http.mjs) · [Worker loop](src/company-worker.mjs)

## Goals, tasks and review

A goal records an outcome, success criteria and one accountable employee. For a new goal, the accountable employee can plan work for itself or assign within its reporting scope. An employee participating in a goal can create tasks for itself. Each task has one assignee, explicit acceptance criteria and optional dependencies on previously created tasks in the same goal.

| Transition | Durable condition |
| --- | --- |
| Ready → Running | The assignee claims due work after every dependency passes review. The claim carries an expiring token and increments the attempt. A replacement claim fences the earlier worker. |
| Running → Ready, Waiting or Blocked | The assignee records its progress or reason. A released task returns to the queue, a scheduled wait becomes eligible at its wake time, and a blocked task needs an explicit resume. |
| Running → Submitted | The assignee supplies evidence for the deliverable. The task enters the designated review queue. |
| Submitted → Ready or Done | An independent manager in scope or the owner inspects the submission, records a decision and explains it. Requesting changes reopens the task for the assignee. |
| Active goal → Done | The goal has at least one task and every task has an accepted review. The accountable employee or an authorized leader can close it. |

When a goal originates in a company conversation, the service verifies that both its creator and its accountable employee can read the exact source message. Closing that goal queues one completion notice in the same transaction. The notice returns to the original conversation, linked to the request, and carries the completion status and goal ID. Company-wide work views omit the private conversation and message IDs.

A logical command carries a stable request ID. Goal and task mutations commit the record, indexes, request receipt, immutable work history where applicable and an audit event together. A retry with the same input returns the original result. Stale claims cannot overwrite later progress. New tasks, submissions and independent review are separate business decisions, including when different employees carry them out. [Domain](src/company-work.mjs) · [Concurrency and recovery tests](test/company-work.test.mjs)

## Data and observability

SQLite shares `company.sqlite` between the local directory and the `foundation_records` table. Each hosted installation uses a DynamoDB table with a retention policy. Versioned V2 records have a distinct `V2#` partition-key namespace. Directory, employment and factory records retain their established keys and identity. On an upgrade, earlier transcripts, notes, goals and leases keep their original format and require explicit migration to appear in the new workspace. Preserve existing data and test rollback when changing the active runtime. [Record adapter](src/foundation-records.mjs) · [SQLite and DynamoDB contract tests](test/foundation-records.test.mjs)

The activity feed shows committed work events. Admin records privileged history reads. Traces and metrics connect model decisions, tool actions and employee handoffs to latency and failures. Trusted W3C trace context links asynchronous work across process restarts. Telemetry allowlists identifiers and status fields. Message bodies, prompts, evidence, browser contents and credentials remain outside exported telemetry. Use the hosted guide for sampling, X-Ray, CloudWatch and the local OTLP receiver. [Observability](infra/TELEMETRY.md) · [Telemetry tests](test/telemetry.test.mjs)

The UI follows Carlo's selected cobalt chat mockup with warm neutral surfaces, a serif wordmark, system sans fallbacks and responsive panels. The implementation reviewed the personal-site stylesheet (Git blob `424c721c4ff3254cb05a671d743488ce653adc6f`) and layout, plus Forge's stylesheet (blob `08f3c81aa2c693d5d38b27c718e2a350a3af6ea8`) and ProjectCard. Core controls support narrow viewports and keyboard navigation. [Personal site](https://github.com/The-CarL/carloperottino-site/blob/main/src/styles/global.css) · [Forge](https://github.com/The-CarL/carloperottino-forge/blob/main/src/styles/global.css)

## Local verification and recovery

Use Node 24.19.0 and npm 11.9.0 from the repository root. `npm ci`, `npm run setup:browser`, `npm run setup:owner` and `npm start` start the owner workspace at `http://127.0.0.1:3000/`. The setup command prints a generated password once and stores the username and salted Argon2id verifier in `.local/owner.json` with mode 0600. To supply a password noninteractively, pass it on stdin with `npm run setup:owner -- --password-stdin`. See the local trial for an explicit goal with a real public source. [Quick start](README.md#run-locally)

```sh
npm run check
```

This command runs the Node suite, synthesizes the foundation and hosted CloudFormation stacks, then runs a real Chromium desktop/mobile workflow against the local server. With `PEROTTINO_DDB_TEST_ENDPOINT` pointing to DynamoDB Local, the storage integration tests use disposable local tables. CI provisions a pinned emulator, validates CloudFormation schemas, builds both Linux x86-64 release images, and exercises the packaged software. CPU-local decisions and provider fixtures keep these checks reproducible. A real Bedrock reply and AgentCore Browser session require a separate check in the target account. [CI](.github/workflows/check.yml) · [Browser smoke](scripts/company-smoke.mjs) · [Worker acceptance](test/company-worker.test.mjs)

For local recovery, stop the service cleanly and preserve the complete `DATA_DIR` as an access-controlled backup. A live SQLite WAL database needs SQLite's backup facility or a consistent snapshot. Restore to a separate directory and verify the roster, conversations, task history and pending reviews before switching the active directory.

## Hosted delivery and acceptance

The destination supplies its own account, region, VPC, public subnets, permissions boundary, model access and owner-verifier ARN. Publish the worker and Lambda images from the intended source revision, retain their manifest digests, and synthesize using the target's private provenance. Review the change set's effect on IAM, existing tasks, data retention, ongoing cost and rollback. Keep physical resources, DNS records, secret references and release receipts in the private inventory. [Release procedure](infra/PORTABILITY.md) · [Hosted stack and pricing](infra/HOSTED.md)

In the destination account, verify HTTPS and owner sign-in, an actual model reply, one employee handling separate messages, and a delegated task progressing while the browser is closed. Compare independent review with its submission and trace the handoff. Inspect a real managed browser read. Replace an active task and verify its history, pending work and employment binding survive. Pause and fire a test employee and confirm delayed events leave it stopped. Record the release revision, CI verdict, cloud readbacks, compute time, token usage, storage requests and owner interventions separately.

The trusted Git worker reads the projects-only PAT from the retained Secrets Manager slot, writes a task branch and opens a pull request. A separate executor runs isolated JavaScript builds and tests. The delivery service publishes successful static builds at an expiring preview URL. Production release authority is configurable per project. [Projects and Git setup](infra/PROJECTS.md) · [Delivery and preview contracts](infra/DELIVERY.md)

## AWS pilot retirement

On November 27, 2026, the owner retired the AWS pilot after verifying private messaging and delegated work. All four CloudFormation stacks reported `DELETE_COMPLETE`. The API, ECS cluster, dedicated network, ECR repository and seven image digests, log group and monitoring resources were removed. The final check found zero running or pending employee tasks.

At the owner’s direction, the DynamoDB company table was deleted without a data backup. The final inventory found no DynamoDB backups or AWS Backup recovery points. Both pilot secrets became inaccessible and entered their seven-day recovery window. Six ECS task-definition revisions remained registered because the scoped role lacked permission to deregister them. These definitions incur no Fargate compute charges. The source repositories and shared DNS hosted zone were preserved. [Retirement procedure](infra/PORTABILITY.md#remove-a-deployment)

## Northern Virginia assessment

The November 27 assessment runs from the feature branch in `us-east-1`. It uses small standalone Fargate tasks, public subnets, a shared $30 work wallet with no automatic refill, and 200 company-wide browser minutes per UTC calendar month. The monthly AWS spending target is $100. AWS Budgets requires separate payer permissions and an active assessment cost-allocation tag. The worker size, concurrent capacity and decisions in the internal ledger determine different parts of the bill. [Budget setup and estimate](infra/ASSESSMENT-BUDGET.md)

The live checks covered owner sign-in, private and group chat, two versions of a shared file, internal email threading, model replies, conversation memory after task replacement and company activity in CloudWatch and X-Ray. The CEO hired a contributor, reviewed the contributor's work and approved a project-specific grant for one QA hire. The test employees were paused after verification. The isolated executor passed a generated JavaScript example and rejected a broken assertion. The sandbox service created an encrypted, tagged queue with a one-hour expiration.

GitHub delivery uses the owner-supplied projects token. Receiving internet mail requires DKIM and MX records in the existing public hosted zone. General external sending also depends on SES sending status. The live portal URL, protected owner handoff, AWS identifiers, inspection receipts and DNS record values are in the private deployment inventory. [Projects credential](infra/PROJECTS.md) · [Mail activation](infra/INBOUND-EMAIL.md)

## Factory continuity

Read the repository's `AGENTS.md` on every continuation. With the verified factory runtime, use `factory-project open --repo the-carl/perottino-co-platform`, confirm the source revision and check existing operations before retrying. Checkpoint changes with `factory-project checkpoint` at delivery milestones. Keep confidential configuration and raw provider responses private. Verify the remote and push through the approved branch/PR path. Preserve initial and latest source/run provenance. Carlo approves cleanup against a concrete resource, data, backup, DNS and publication inventory. A retained resource or stale preview can continue incurring costs. [Operating rules](AGENTS.md) · [Pinned factory standards](https://github.com/the-carl/engineering-factory/tree/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards) · [Design references](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/design-references.md) · [Provider workflows](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/provider-workflows.md)

The pinned product co-architecture standard covers material scope changes. Use the narrower testing, deployment and cleanup references for subsequent delivery work. If the product gains a native Android target, apply the Android-specific standard and delivery guide linked here. [Product co-architecture](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/product-architecture.md) · [Testing](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/testing.md) · [Deployment](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/deployment.md) · [Cleanup](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/cleanup.md) · [Android](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/android.md) · [Android delivery](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/android-delivery.md)
