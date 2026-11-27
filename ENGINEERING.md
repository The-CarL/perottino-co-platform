# Perottino & Co. engineering contract

Carlo owns the AWS account, company mandate, spending authority and release decisions. The platform repository holds the employee runtime, owner console and privileged infrastructure definitions. Employees' applications and tools belong in the separate projects repository. Both source repositories are public. Keep company messages, personal notes, provider account IDs, private inventories and secret material outside Git. [Platform](https://github.com/The-CarL/perottino-co-platform) · [Projects](https://github.com/The-CarL/perottino-co-projects)

## Reproducing a change

For each platform capability, commit its source, dependency pins, local entry point and a test of the user-facing behavior in the same change. Describe its configuration and how to verify it from a clean checkout. Provide a local substitute or fixture for each paid or account-specific dependency, and identify which acceptance check still requires the real provider.

Describe every new persistent AWS resource, permission and integration in versioned infrastructure as code before provisioning it. Review the synthesized change, apply it to the intended environment, and record deployment and readback in the private inventory. Keep secret values outside templates and reproducible build inputs. A previous deployment should be recoverable from a source revision, environment configuration, protected data backups and owner-supplied credentials.

The implementing agent owns the review of platform changes. Review the final commit, correct findings, rerun the applicable checks and record the technical verdict on the pull request. GitHub enforces the repository's formal review rules separately. Owner participation in local setup or test execution is unnecessary.

## First operating milestone

Carlo opens `/chat`, authenticates, finds Mara by name, handle or CEO role, sends a direct message and receives one answer. He can inspect a saved memory, see the message it came from, correct it or delete it. After restarting the process with the same data directory, Mara retains the conversation and can recall the corrected note. The local milestone also exercises reading a public web document.

The broader company design gives each employee a persistent identity, company email address, tools and authority. The week-later app change remains the end-to-end test for hiring, code delivery, recorded ownership and recovery. Before that trial, validate the hosted runtime in the target account and implement the outbound mail service, Git worker, project-scoped provisioning and promotion grants. Track outcome quality, elapsed time, actual spend and each owner intervention.

## What runs

| Component | Implementation and ownership |
| --- | --- |
| Owner console | The Node HTTP server runs locally. On AWS, API Gateway HTTP API terminates HTTPS and Lambda serves the equivalent authenticated routes and static UI. Secrets Manager stores the owner verifier. |
| Durable data | SQLite and its WAL are local development storage. The hosted runtime uses an on-demand DynamoDB table for employee identity, messages, leases, memory and receipts. API writes acknowledge committed work. Lease fencing prevents a worker that lost ownership from publishing a reply. |
| Execution | Bootstrap and hiring launch standalone Fargate tasks. Each active employee checks its inbox for email and chat, or works on a due goal. One task handles many turns. A bounded model step can checkpoint a goal and set its next wake. The factory fences stopped tasks by employee identity, execution generation and task ARN. |
| Hiring | The CEO starts with hiring authority. Each hire receives a stable identity, manager, initial assignment and its own resident task. The default company limit is 100 employees including the CEO. |
| Mail | Optional SES receipt rule, SNS topic and Lambda map a dedicated domain’s email addresses to the durable inbox. External messages carry their own sender attribution. Outbound delivery is pending. [Inbound mail](infra/INBOUND-EMAIL.md) |
| Browser | Both paths enforce bounded public-document reads and validate redirects. Local tests use Chromium. On AWS, a requested read starts an AgentCore Browser session, renders the fetched material with subresources and scripts disabled, then closes it. The browser is a separate managed service. |
| Recovery | ECS stopped events and periodic reconciliation replace employees whose desired state is active. Pausing or firing an employee changes durable state before stopping its task. The table retains history and has point-in-time recovery. [Hosted recovery](infra/HOSTED.md) |

The UI follows Carlo's selected cobalt chat mockup with warm neutral surfaces, a serif wordmark, system sans fallbacks and responsive panels. The implementation reviewed the personal-site stylesheet (Git blob `424c721c4ff3254cb05a671d743488ce653adc6f`) and layout, plus Forge's stylesheet (blob `08f3c81aa2c693d5d38b27c718e2a350a3af6ea8`) and ProjectCard. Core controls remain usable with a narrow viewport and keyboard navigation. [Personal site](https://github.com/The-CarL/carloperottino-site/blob/main/src/styles/global.css) · [Forge](https://github.com/The-CarL/carloperottino-forge/blob/main/src/styles/global.css)

## Local operation and verification

Use Node 24.19.0 and npm 11.9.0 from the repository root. For a fresh local workspace run these commands in order.

```sh
npm ci
npm run setup:browser
npm run setup:owner
npm start
```

Open `http://127.0.0.1:3000/chat`. The interactive owner setup displays a generated password once and saves only the username and salted Argon2id verifier in `.local/owner.json` with mode 0600. For unattended provisioning pipe the password to `npm run setup:owner -- --password-stdin` or supply it through a protected `OWNER_PASSWORD` environment variable. Set `OWNER_USERNAME` to override the default `owner` name and `DATA_DIR` to choose a durable local directory. Setup refuses to replace an existing owner file.

```sh
npm test
npm run synth
npm run test:smoke
```

`npm run check` runs all three commands. CI installs Chromium and the required OS packages, synthesizes the hosted stack, then executes the source and image checks on Ubuntu with read-only repository permissions. The operator owns these checks. The owner can use the hosted service without a development environment. A prepared machine can use an explicitly selected Chromium binary via `PEROTTINO_CHROMIUM_PATH`. The smoke uses disposable data and checks owner authentication, directory lookup, a DM, a sourced memory and a restart followed by recall on a mobile viewport. Set `PEROTTINO_SCREENSHOT_DIR` to a private directory for screenshots. Browser tests also exercise a controlled HTTP fixture through the actual reader. The Bedrock transport test substitutes a decision provider. A successful live inference requires observing an actual response under the approved AWS role. [CI](.github/workflows/check.yml) · [Browser smoke](scripts/smoke.mjs)

For recovery, stop the local service cleanly and preserve the complete data directory as an encrypted, access-controlled backup. A live SQLite WAL database needs SQLite's backup facility or a consistent snapshot. Restore to a separate directory first and verify the directory, chat and memory records before switching `DATA_DIR`. Preserve the original data through rollback. Refreshes and network retries of a single write use the original request ID.

## Hosted delivery and verification

Use the AWS-managed API Gateway HTTPS endpoint for initial validation. The owner can map `co.carloperottino.com` later with a regional ACM certificate and the approved DNS record. The preconfigured AWS target supplies its account, region, VPC, public subnets, image digests, owner-verifier ARN, IAM boundary and Bedrock profile. The active design has no EC2 instance, always-on ECS service, EBS data volume, load balancer or NAT gateway. [Account release procedure](infra/PORTABILITY.md) · [Hosted stack](infra/HOSTED.md)

A running employee incurs continuous Fargate and IPv4 charges. Operator acceptance in a destination account includes signing into the console, seeing bootstrap launch precisely one CEO, delivering multiple DMs to the same ECS task and observing a durable goal advance after the browser closes. Verify a real Bedrock response and AgentCore Browser read. Stop an active task, confirm that its replacement preserves the checkpoint, then pause and fire a test employee and verify that delayed events leave it stopped. Record actual task-hours, tokens, DynamoDB reads and writes, browser session time and owner interventions. [Cost assumptions](infra/PORTABILITY.md)

The retained Secrets Manager slot `/perottino-co/github/pat` was created in us-east-1. The stack reached CREATE_COMPLETE with zero secret versions. Its source template was committed at `73474040419a68c852b45aa646bb8b6a43862cbd`. The owner supplies an expiring projects-repository token privately when the Git worker is ready. Only the trusted Git worker should be able to read the token. The feature-branch pilot in us-east-1 now runs the release bootstrap, a project-owned network, and the hosted employee stack. The owner signs in at the private-inventory API Gateway URL. Bootstrap created one CEO under a 100-employee limit. The authenticated owner console and a managed AgentCore Browser read have been verified live. The custom domain and mail stack remain optional. Keep provider receipts and physical inventories in the approved private record. [Secret declaration](infra/github-pat.yaml)

Synthesize with the real private provenance input before deployment. Review the change set, protected-resource exclusions, effect on existing resources, recurring costs, rollback and data recovery. Record the approved account and region, role, commit, image digest, change-set result, resources and DNS changes in the private project record. Verify HTTPS and owner authentication from a browser, an actual Bedrock reply, an owner memory correction, and recovery after replacing the worker. A fresh hosted employee must recover from shared durable state after losing its local disk. Record the release revision, CI run and live test results separately.

## Factory continuity

Read the repository's `AGENTS.md` on every continuation. With the verified factory runtime, use `factory-project open --repo the-carl/perottino-co-platform`, confirm the source revision and check existing operations before retrying. Checkpoint changes with `factory-project checkpoint` at delivery milestones. Keep confidential configuration and raw provider responses private. Verify the remote and push through the approved branch/PR path. Preserve initial and latest source/run provenance. Carlo approves cleanup against a concrete resource, data, backup, DNS and publication inventory. A retained resource or stale preview can continue incurring costs. [Operating rules](AGENTS.md) · [Pinned factory standards](https://github.com/the-carl/engineering-factory/tree/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards) · [Design references](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/design-references.md) · [Provider workflows](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/provider-workflows.md)

The pinned product co-architecture standard covers material scope changes. Use the narrower testing, deployment and cleanup references for subsequent delivery work. If the product gains a native Android target, apply the Android-specific standard and delivery guide linked here. [Product co-architecture](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/product-architecture.md) · [Testing](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/testing.md) · [Deployment](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/deployment.md) · [Cleanup](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/cleanup.md) · [Android](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/android.md) · [Android delivery](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/android-delivery.md)
