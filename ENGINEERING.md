# Perottino & Co. engineering contract

Carlo owns the AWS account, company mandate, spending authority and release decisions. The platform repository holds the employee runtime, owner console and privileged infrastructure definitions. Employees' applications and tools belong in the separate projects repository. Both source repositories are public. Keep company messages, personal notes, provider account IDs, private inventories and secret material outside Git. [Platform](https://github.com/The-CarL/perottino-co-platform) · [Projects](https://github.com/The-CarL/perottino-co-projects)

## Reproducing a change

For each platform capability, commit its source, dependency pins, local entry point and a test of the user-facing behavior in the same change. Describe its configuration and how to verify it from a clean checkout. Provide a local substitute or fixture for each paid or account-specific dependency, and identify which acceptance check still requires the real provider.

Describe every new persistent AWS resource, permission and integration in versioned infrastructure as code before provisioning it. Review the synthesized change, apply it to the intended environment, and record deployment and readback in the private inventory. Keep secret values outside templates and reproducible build inputs. A previous deployment should be recoverable from a source revision, environment configuration, protected data backups and owner-supplied credentials.

## First operating milestone

Carlo opens `/chat`, authenticates, finds Mara by name, handle or CEO role, sends a direct message and receives one answer. He can inspect a saved memory, see the message it came from, correct it or delete it. After restarting the process with the same data directory, Mara retains the conversation and can recall the corrected note. The local milestone also exercises reading a public web document.

The broader company design gives each employee a persistent identity, company email address, tools and authority. The week-later app change remains the end-to-end test for hiring, code delivery, recorded ownership and recovery. Before that trial, implement the hosted storage and dispatch adapters, SES routing and mail outbox, Git worker, project-scoped provisioning and recruiting rules. Track outcome quality, elapsed time, actual spend and each owner intervention.

## What runs

| Component | Operational contract |
| --- | --- |
| Owner console | The Node HTTP service serves a responsive employee directory, direct messages and memory controls. The client polls the API. All app routes and static assets require owner authentication. The public health check at `/healthz` reports HTTP availability. |
| Identity, chat and memory | The local store at `DATA_DIR/company.sqlite` uses SQLite transactions and WAL. Mara has stable ID `ceo` and personal handle `mara`. The service records each incoming message and its request ID before acknowledging it. A lease limits an employee to one active turn. Completion checks the lease token, expiry and owner memory edits before publishing the reply and staged notes together. |
| Employee runner | Local mode supports explicit `remember`, `recall` and `browse` commands. Other input returns help. In Bedrock mode, the console sends bounded history and memory to an isolated decision worker. It accepts only reply, remember, recall and browse decisions. The app executes the allowed action. |
| Inference worker | The pinned Codex TypeScript SDK uses its native Amazon Bedrock provider and an ECS workload identity. The worker isolates its temporary workspace and home. Its role should have access only to the selected inference profile and its required models. Keep the application store, owner credentials and Git credential out of this process. |
| Public-page reader | The reader verifies public destinations, pins DNS resolution for each connection, rechecks redirects and bounds response size and duration. Playwright Chromium renders the fetched content offline with scripts disabled in a fresh context. Signed-in browsing, interaction, takeover and persistent desktops are later integrations. |
| AWS foundation | The CDK assembly defines a protected on-demand DynamoDB table with point-in-time recovery, a versioned private corporate S3 bucket, a wake queue and a dead-letter queue. The current console reads SQLite. Cloud deployment requires connecting the runtime to these services and verifying recovery from fresh compute. [Foundation and recovery](infra/README.md) |

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

`npm run check` runs all three commands. CI installs Chromium and the required OS packages, then runs this sequence on Ubuntu with local agent mode and read-only repository permissions. A prepared machine can use an explicitly selected Chromium binary via `PEROTTINO_CHROMIUM_PATH`. The smoke uses disposable data and checks owner authentication, directory lookup, a DM, a sourced memory and a restart followed by recall on a mobile viewport. Set `PEROTTINO_SCREENSHOT_DIR` to a private directory for screenshots. Browser tests also exercise a controlled HTTP fixture through the actual reader. The Bedrock transport test substitutes a decision provider. A successful live inference requires observing an actual response under the approved AWS role. [CI](.github/workflows/check.yml) · [Browser smoke](scripts/smoke.mjs)

For recovery, stop the local service cleanly and preserve the complete data directory as an encrypted, access-controlled backup. A live SQLite WAL database needs SQLite's backup facility or a consistent snapshot. Restore to a separate directory first and verify the directory, chat and memory records before switching `DATA_DIR`. Preserve the original data through rollback. Refreshes and network retries of a single write use the original request ID.

## Hosted delivery and verification

The intended owner entry point is `https://co.carloperottino.com/chat` in the US East (N. Virginia) pilot. The runtime accepts `OWNER_USERNAME` and `OWNER_PASSWORD_HASH` injected through the protected hosting configuration. Provision a separate owner-auth secret before enabling hosted access. Set `PUBLIC_ORIGIN` to the exact HTTPS origin, preserve Host, replace forwarded scheme headers at the trusted ingress, and restrict backend connections to that ingress. Run the service with `NODE_ENV=production`. Only local loopback HTTP is supported for unencrypted development. CLI writes need the `X-Requested-With: owner-console` header when browser origin information is absent.

For the live model path, run `npm run start:model-worker` in the isolated workload. Configure `PEROTTINO_AGENT_MODE=bedrock`, the private `PEROTTINO_BEDROCK_WORKER_URL` and a protected `PEROTTINO_BEDROCK_WORKER_TOKEN` for the console and worker as applicable. Confirm the region, approved inference profile, IAM access and budget before invoking the model. Quotas on concurrent turns and calls bound individual requests. A company spending ceiling still needs enforcement in the hosted system.

The retained Secrets Manager slot `/perottino-co/github/pat` was created in us-east-1. The stack reached CREATE_COMPLETE with zero secret versions. Its source template was committed at `73474040419a68c852b45aa646bb8b6a43862cbd`. The owner supplies an expiring projects-repository token privately when the Git worker is ready. Only the trusted Git worker should be able to read the token. At this checkpoint the remaining AWS platform resources and custom chat URL await deployment. Keep provider receipts and physical inventories in the approved private record. [Secret declaration](infra/github-pat.yaml)

Synthesize with the real private provenance input before deployment. Review the change set, protected-resource exclusions, effect on existing resources, recurring costs, rollback and data recovery. Record the approved account and region, role, commit, image digest, change-set result, resources and DNS changes in the private project record. Verify HTTPS and owner authentication from a browser, an actual Bedrock reply, an owner memory correction, and recovery after replacing the worker. A fresh hosted employee must recover from shared durable state after losing its local disk. Record the release revision, CI run and live test results separately.

## Factory continuity

Read the repository's `AGENTS.md` on every continuation. With the verified factory runtime, use `factory-project open --repo the-carl/perottino-co-platform`, confirm the source revision and check existing operations before retrying. Checkpoint changes with `factory-project checkpoint` at delivery milestones. Keep confidential configuration and raw provider responses private. Verify the remote and push through the approved branch/PR path. Preserve initial and latest source/run provenance. Carlo approves cleanup against a concrete resource, data, backup, DNS and publication inventory. A retained resource or stale preview can continue incurring costs. [Operating rules](AGENTS.md) · [Pinned factory standards](https://github.com/the-carl/engineering-factory/tree/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards) · [Design references](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/design-references.md) · [Provider workflows](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/provider-workflows.md)

The pinned product co-architecture standard covers material scope changes. Use the narrower testing, deployment and cleanup references for subsequent delivery work. If the product gains a native Android target, apply the Android-specific standard and delivery guide linked here. [Product co-architecture](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/product-architecture.md) · [Testing](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/testing.md) · [Deployment](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/deployment.md) · [Cleanup](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/cleanup.md) · [Android](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/standards/android.md) · [Android delivery](https://github.com/the-carl/engineering-factory/blob/14ed9d222230ae85dd14b9baaf2a754e309b982f/docs/android-delivery.md)
