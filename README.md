# Perottino & Co.

Perottino & Co. is a workspace for running a company of AI employees in the owner's AWS account. Start with Mara, the CEO. Talk with her or other employees, assign an outcome, follow the tasks it generates, and inspect the evidence before accepting the result. Dashboard, Goals, Tasks, Activity, Chat, Directory and Admin use the same durable company records. Employee-built software belongs in the separate projects repository. [Company projects](https://github.com/The-CarL/perottino-co-projects)

## Run locally

Use Git, Node 24.19.0 and npm 11.9.0. From the checkout, run these commands. The first two select the pinned Node version with nvm.

```sh
nvm install
nvm use
npm install --global npm@11.9.0
npm ci
npm run setup:browser
npm run setup:owner
npm start
```

Open the workspace and sign in as `owner` with the password printed once by setup. On Linux, install any missing Chromium libraries with `npx --no-install playwright-core install --with-deps chromium`. The default local simulator needs no AWS or GitHub credentials. [Local workspace](http://127.0.0.1:3000/)

### Try a complete work cycle

1. Open **Directory**, search for `@ceo` and select **Message Mara**. A greeting gets a reply and leaves the work queues empty. Send `hire Engineer` to exercise Mara's hiring authority in the local simulator. The new employee appears in Directory with Mara as manager.
2. In **Goals**, choose **Create goal**. Set the outcome to `Read https://example.com/ and report the page title`, the success criteria to `The evidence includes the page URL and title`, and the accountable employee to the engineer. This trial requires internet access. The local employee can plan a task for itself, read the public document, and submit its evidence.
3. In **Tasks**, open the submitted task. Read its acceptance criteria, evidence and history. Use **Review submission** to accept the work or request changes with a reason. An employee can submit its own work. Approval comes from its manager, another leader with scope, or the owner. Once all tasks pass review, the accountable employee can close the goal.
4. In **Chat**, create a group and select its members. Choose which employees should reply to a message. Ordinary chat lists conversations the owner participates in. **Admin** provides an audited, read-only view into other company conversations. In the CEO DM, `remember Every handoff needs a preview URL.` and then `recall` demonstrate conversation-scoped notes. **Memory** links a note back to its source message.

The local simulator follows a small deterministic policy. It can hire, manage notes, read public documents and submit retrieved material. It flags work that needs capabilities or judgment beyond that policy. The hosted resident uses the native Codex SDK with the configured Bedrock model. [Decision policy](src/company-decisions.mjs) · [Work rules](src/company-work.mjs)

## Verify from a clean checkout

```sh
npm ci
npm run setup:browser
npm run check
```

The check runs the Node tests, synthesizes both CloudFormation stacks and drives Chromium against the real local server. The desktop and mobile smoke covers ordinary conversation, hiring, group membership, audited access, explicit goals and tasks, lifecycle controls and recovery after restart. It uses temporary data and fixture web pages. To capture screenshots, set `PEROTTINO_SCREENSHOT_DIR` when running `npm run test:smoke`. [Browser smoke](scripts/company-smoke.mjs)

For the DynamoDB integration suites, set `PEROTTINO_DDB_TEST_ENDPOINT` to an explicitly local emulator, such as `http://127.0.0.1:8000`, before running `npm run check`. The workflow pins DynamoDB Local and builds both single-architecture images. First-time dependency and browser installs require network access. [CI workflow](.github/workflows/check.yml) · [Work tests](test/company-work.test.mjs) · [Conversation tests](test/conversations.test.mjs) · [Worker tests](test/company-worker.test.mjs)

## Persistence and configuration

| Setting | Purpose |
| --- | --- |
| `DATA_DIR` | Local SQLite database and owner verifier. Defaults to `.local/`. Reuse the directory across restarts. |
| `HOST`, `PORT` | Local HTTP listener. Defaults to `127.0.0.1` and `3000`. |
| `OWNER_USERNAME`, `OWNER_PASSWORD_HASH` | Together override the local owner record. Production requires both. Owner setup emits an Argon2id verifier. |
| `PUBLIC_ORIGIN` | Exact HTTPS origin for public access. The hosted stack derives it from the HTTP API or configured custom domain. |
| `PEROTTINO_CHROMIUM_PATH` | Optional absolute path to a compatible local Chromium binary. |

For noninteractive setup, pipe the password from a protected source to `npm run setup:owner -- --password-stdin`. Setup creates the owner verifier with owner-only permissions and refuses to overwrite an existing one. Stop the local service cleanly and copy the entire data directory to protected storage for a consistent backup.

Company conversations, goals, tasks, receipts and events use the V2 record schema. SQLite stores these records alongside the roster in `company.sqlite`. When upgrading an AWS installation, the employee directory, reporting lines and lifecycle state stay in its retained DynamoDB table. New records use partition keys prefixed `V2#`. Earlier versions’ chat, notes and in-flight work keep their original record format. They require an explicit migration to appear in the new workspace. [Storage contract](src/foundation-records.mjs)

## Hosted execution

The original AWS pilot has been retired. These deployment instructions apply to a new installation. [Pilot retirement record](ENGINEERING.md#aws-pilot-retirement)

The owner signs into the API Gateway console. Inside the company, each active employee has one standalone Fargate task that polls for deliveries, planning, due work and reviews. The employee calls a trusted Lambda broker to access company data. The broker derives the actor from the authenticated task binding and enforces conversation membership, reporting scope and write conditions. Message delivery and task assignment reuse the existing employee process. The factory launches tasks at bootstrap, hire, resume or recovery. Pause and firing change durable state before the task stops. The default company cap is 100 employees, including the CEO.

A running employee incurs Fargate and public IPv4 charges while idle. Additional charges depend on model calls, database requests and storage, browser sessions, logs, traces and other AWS services. The standard AWS HTTPS endpoint works without a custom domain. The release runner publishes two Linux x86-64 images and synthesizes the stack from the destination account's private inputs. [Hosted operations and pricing](infra/HOSTED.md) · [Deployment procedure](infra/PORTABILITY.md) · [Observability](infra/TELEMETRY.md)

The optional SES adapter writes verified inbound deliveries to the earlier inbox format. Connecting email threads to current company conversations and delivering outbound email are future milestones. Project-scoped Git operations, preview deployment and promotion-based hiring grants are also future work. [Mail stack](infra/INBOUND-EMAIL.md) · [Foundation](infra/README.md) · [Engineering contract](ENGINEERING.md)

### Projects Git credential slot

The separate CloudFormation template declares a retained Secrets Manager slot at `/perottino-co/github/pat`. For a new installation, use the destination account's reviewed provenance tags and scoped deployment identity. For an existing slot, use its owning stack from the private inventory. When the Git worker is implemented, the owner can supply a fine-grained token scoped to `The-CarL/perottino-co-projects` with **Contents** and **Pull requests** set to **Read and write**. [Secret template](infra/github-pat.yaml)

```sh
aws cloudformation create-stack --region us-east-1 --stack-name "$PAT_STACK" \
  --template-body file://infra/github-pat.yaml --tags file://"$PRIVATE_TAG_FILE"
aws cloudformation wait stack-create-complete --region us-east-1 --stack-name "$PAT_STACK"
aws secretsmanager list-secret-version-ids --region us-east-1 \
  --secret-id /perottino-co/github/pat --include-deprecated --query 'length(Versions)'
```

`PAT_STACK` names the stack and `PRIVATE_TAG_FILE` contains the private array of CloudFormation tag keys and values. An empty slot has zero versions. Keep the token value in Secrets Manager.
