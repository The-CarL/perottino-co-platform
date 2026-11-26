# AWS durable foundation

This optional CDK assembly is a foundation for future shared company files and task queues. The current hosted deployment declares its own DynamoDB table with a stream, dispatch and recovery resources in one stack. Deploy the hosted stack to run this milestone. The local simulator uses SQLite. [Active hosted deployment](PORTABILITY.md)

| Resource | Contract |
| --- | --- |
| Company state | DynamoDB on-demand table with string keys `pk` and `sk`, service encryption at rest, deletion protection and point-in-time recovery. It can hold directory entries, inbound commands, leases, idempotency records and checkpoint pointers. |
| Corporate files | S3 bucket with versioning, S3-managed encryption, bucket-owner-enforced object ownership, public access blocked and HTTPS required. Record object key and version ID for each durable reference. Keep service-only raw mail, secrets and internal checkpoint material outside employee-writable file paths. |
| Wake delivery | Encrypted standard SQS queue with HTTPS required, four-day message retention and five-minute visibility. A wake identifies durable work in DynamoDB. A consumer must acquire a fenced lease and persist its result before acknowledgement. Renew visibility or hand work to a durable dispatcher for longer runs. |
| Dead-letter delivery | Encrypted HTTPS-only SQS queue with fourteen-day retention. SQS redrives messages after five unsuccessful receives. Durable work must survive expiry of either queue. |

The four outputs provide the table name, corporate bucket name and queue URLs. Each resource and its transport policy has both deletion and replacement retention. The CDK assembly requests stack termination protection. A direct CloudFormation caller must enable that stack setting separately. Provider-generated resource names support replacement without collision. Keep construct IDs stable to preserve logical IDs.

## Synthesize and review locally

Use the repository's pinned Node version and lockfile from the repo root.

```bash
npm ci
npm run synth
node --test test/infra.test.mjs
```

The default input is [a synthetic provenance record](example-provenance.json). It writes `cdk.out/Foundation.template.json` and its assembly manifest. Use a private copy of the record and a separate output directory to prepare a deployment review.

```bash
npm run synth -- --provenance /private/foundation-provenance.json --outdir /private/foundation-assembly
```

The private input contains the project's 19 factory tags. Scope is derived as `factory:s=<project UUID>-<environment>`. For initial creation, the stack, table, bucket and queues use those tags. Set `factory:expires-at` to a reviewed UTC timestamp or `none` for approved durable storage. Tag values appear in the template and on AWS. Use nonsecret aliases for people and source labels.

For subsequent changes, preserve the original record. Under `overrides`, supply the latest run ID, source commit, branch and author for each changed resource. Valid keys are `Foundation` (the stack), `State`, `Files`, `Wake` and `DeadLetters`. Keep overrides from previous releases. Each taggable resource has its own full tag set in the synthesized template. The stack's tag set is present in the assembly manifest. A direct CloudFormation deployment must also supply those stack tags when creating the change set. The bucket and queue policy resources have no tag field. Track them by logical ID, parent, provider reference and change in the private inventory. Verify ownership and tags with service readback after an approved deployment.

## AWS review and recovery

Review the synthesized template and the named change set against the exact account, region, project and environment. Use the factory stack namespace `factory-<scope>-r-foundation` and the reviewed project-scoped identity. The stack needs CloudFormation stack/change-set permissions and permissions to create, configure, tag and read back its table, bucket, queues and policies. This template is asset-free and creates no IAM roles. It requires no CloudFormation `CAPABILITY_IAM`, `CAPABILITY_NAMED_IAM` or CDK bootstrap role. Authorization depends on the actual provider policies, resource scopes and protected-resource exclusions. Review replacements, recurring storage/backup costs and retention before execution. Record the change set, source SHA, physical IDs, outputs and readback in private project inventory.

A failed or interrupted operation can leave retained resources behind. Reconcile stack events, physical IDs, data versions and inventory before retrying. For a table incident, restore a selected point in time to a new table, check records and explicitly repoint consumers after verification. For a file incident, read the recorded object version and copy it to a new current version to restore it. For a dead-letter incident, inspect the durable work item's state and side effects, correct its cause and replay the same idempotency key. Keep the original recovery references. Resource retention preserves data and can continue to incur charges after a stack change. Cleanup follows a separately agreed resource and data plan.

Connecting the shared corporate bucket and queue to employee tools is future work. The Git credential slot has its own lifecycle. [Git worker secret template](github-pat.yaml)
