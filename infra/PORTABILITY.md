# Releasing the platform into another AWS account

Use this procedure from a release runner with Git, Node and npm at the repository pins, Docker Buildx and AWS CLI v2. PR validation needs only a Linux runner, Docker and access to public dependency registries. The owner does not need development software or a running copy of the platform.

## Select the target

Use an AWS commercial-region deployment role in the **destination account**. Pin the release to a reviewed Git commit. Supply the account's private provenance tags, approved VPC, public subnet and AZ, ECS-optimized AL2023 x86_64 AMI, delegated hostname, permissions boundary and permitted Bedrock model resources. DNS ownership, public internet access and access to the selected Bedrock model are deployment prerequisites. Verify that the chosen subnet has a route to an internet gateway and that the VPC has DNS enabled. Region-specific inference profiles can have destination-region IAM requirements. Keep private target data in the deployment inventory. [Hosted configuration and recovery](HOSTED.md)

## Bootstrap account-owned resources

Use the two asset-free CloudFormation templates with the target role and project tags. Use a distinct stack name in the project namespace for each template. Use the same project and environment scope as the hosted stack, including the derived `factory:s` tag on the runtime bootstrap. The bootstrap declares separate `perottino:purpose` tags on the owner verifier, worker token and image repository. The runtime permissions use these tags. Enable termination protection for these retained resources. Inspect any existing stack and resource inventory before creation.

| Template | Scope and lifecycle |
| --- | --- |
| [Git credential](github-pat.yaml) | One retained `/perottino-co/github/pat` slot per account and region. Same name, new ARN in the destination account. A new slot has zero versions. The owner supplies the projects-repo PAT later. CloudFormation never receives its value. Only the future Git worker needs read access. In the original account, continue using the already deployed owning stack. |
| [Runtime bootstrap](runtime-bootstrap.yaml) | Provider-named immutable ECR repository, empty owner-verifier secret, and a separate generated worker authentication token. The template emits names, URI and ARNs. The console and model worker can launch while the Git credential is empty. |

The following commands illustrate initial creation in a fresh target with an approved role. For existing resources, review a change set against their owning stack. Do not blindly recreate or import a secret with the same name. Use `PRIVATE_TAG_FILE` for the target's private CloudFormation array of `Key` and `Value` records.

```sh
aws cloudformation create-stack --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK" \
  --template-body file://infra/runtime-bootstrap.yaml --enable-termination-protection \
  --tags file://"$PRIVATE_TAG_FILE"
aws cloudformation wait stack-create-complete --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK"
aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK" \
  --query 'Stacks[0].Outputs'
```

Initialize the owner verifier on a protected release runner. `npm run setup:owner -- --password-stdin` reads a password from a protected input and writes a JSON verifier to `DATA_DIR/owner.json`. Populate the empty `OwnerSecretArn` with that file using Secrets Manager's `put-secret-value --secret-string file://…`. Inspect version metadata first and preserve an existing value on subsequent releases. The generated worker token is injected into the designated tasks by ECS. Each account owns its secret values and encryption context independently. Credential rotation is a separate operation.

## Publish immutable images

Run the checked-in image publisher with the target account ID, Region and owning runtime bootstrap stack. It verifies the caller's account and the registry returned by that stack, logs in with a temporary Docker config, and builds for Linux x86_64 from the Git commit. Use a system-installed Docker Buildx plugin on the runner and its default engine or an explicitly configured `DOCKER_HOST`. A release runner with a TLS-inspecting package proxy can mount its public CA with `BUILD_CA_FILE`. The release runner needs ECR authorization and push/pull access to the selected repository. An existing immutable tag is reused on a retry. The command emits the target ECR digest URIs for the console/worker and TLS proxy. Record both in the private release config.

```sh
TARGET_ACCOUNT="$DESTINATION_ACCOUNT" AWS_REGION="$DESTINATION_REGION" \
  BOOTSTRAP_STACK="$BOOTSTRAP_STACK" bash scripts/publish-images.sh > "$PRIVATE_IMAGES_JSON"
```

The upstream Caddy manifest and app base images are pinned. Record private-registry digests returned by the target registry. A new account gets its own repository URIs even when it runs the same source revision. [Image publisher](../scripts/publish-images.sh) · [Application image](../Dockerfile) · [Proxy image](Proxy.Dockerfile)

## Review a release

Build a private hosted JSON configuration from the example with the two published image URIs and the bootstrap secret ARNs. Run `npm run synth:hosted -- --config "$HOSTED_CONFIG" --provenance "$PRIVATE_PROVENANCE" --outdir "$PRIVATE_ASSEMBLY"`. Review the resulting hosted template, IAM, snapshots/retention, cost, DNS change and replacement behavior in a CloudFormation change set for the selected account. Supply the stack tags and appropriate IAM capability when preparing that change set. Approve and execute it in the target account when ready to release. [Configuration example](example-hosted.json) · [Hosted stack](HOSTED.md)

For a private CloudFormation change set, serialize the generated template without indentation. The hosted stack name comes from `artifacts.Hosted.properties.stackName` in the assembly's `manifest.json`. Use that same stack on subsequent releases. For a new stack set `CHANGE_TYPE=CREATE`, or use `UPDATE` for an existing one. The tags file for this operation must match the hosted stack's synthesized provenance. An operator with deployment authority can prepare and inspect a change set using these commands.

```sh
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[2], JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1]))))' \
  "$PRIVATE_ASSEMBLY/Hosted.template.json" "$PRIVATE_ASSEMBLY/hosted.compact.json"
aws cloudformation create-change-set --region "$AWS_REGION" --stack-name "$HOSTED_STACK" \
  --change-set-name "$RELEASE_ID" --change-set-type "$CHANGE_TYPE" \
  --template-body file://"$PRIVATE_ASSEMBLY/hosted.compact.json" \
  --capabilities CAPABILITY_NAMED_IAM --tags file://"$PRIVATE_TAG_FILE"
aws cloudformation wait change-set-create-complete --region "$AWS_REGION" \
  --stack-name "$HOSTED_STACK" --change-set-name "$RELEASE_ID"
aws cloudformation describe-change-set --region "$AWS_REGION" \
  --stack-name "$HOSTED_STACK" --change-set-name "$RELEASE_ID"
```

If the private template exceeds CloudFormation's 51,200-byte inline limit, stage it under a versioned key in the destination account's private release bucket and use its HTTPS S3 URL via `--template-url`. After the release is approved, execute the named change set, wait for stack completion, and enable stack termination protection. Review changes to IAM, host, EBS and DNS before execution. Maintain a tested snapshot for host or storage replacement.

The single-host release keeps SQLite on an encrypted block device. The HTTP console, model inference and offline browser rendering run under separate ECS task definitions. The renderer receives document bytes through a Unix socket, shares no application data or credentials, and has no network interface beyond loopback. The services share the host kernel. Host replacement requires controlled downtime and volume reattachment or snapshot recovery. The separate DynamoDB/S3/SQS foundation is for a future distributed runtime. It can be synthesized independently. [Durable foundation](README.md)

After deployment, verify the HTTPS sign-in, send a free-form DM through the actual target-account Bedrock role, open a public page, save and correct a memory, and restart the workload to check recovery. Record the commit, registry digests, stack outputs, secret **references**, test results and rollback snapshot in the private inventory. Source tests, container tests and account-specific template synthesis run before this provider acceptance check.
