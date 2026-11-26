# Release into a target AWS account

The release runner builds the images and prepares the CloudFormation change set. The owner needs no development machine. The active hosted stack uses a managed HTTPS API, Lambda functions, DynamoDB Streams, Step Functions Standard, and one-shot AWS Fargate tasks. The target supplies its own account, public subnet, permissions boundary and Bedrock access. [Architecture, cost and recovery](HOSTED.md)

## Select the target

Use a reviewed source revision and a scoped AWS commercial-region deployment identity. Confirm its account and region with STS before creating resources. Use a private copy of the [provenance example](example-provenance.json) and retain the original creation metadata on updates. The derived scope is the project UUID, a hyphen and the environment name. Supply the complete resulting tag set, including `factory:s`, as a private CloudFormation JSON array of `Key` and `Value` records. Stack and function names, model access, browser availability and image digests are specific to the target.

Select public IPv4 subnets in the specified VPC with working DNS and an internet-gateway default route. Fargate assigns a temporary public IPv4 address to the running task for ECR, Bedrock and permitted outbound requests. Its security group has no inbound rules. The API and orchestration Lambdas use the Lambda-managed network. The standard API Gateway HTTPS URL works without a custom domain, hosted zone, certificate, load balancer or NAT gateway.

## Bootstrap once per target

| Template | What it provisions |
| --- | --- |
| [Runtime bootstrap](runtime-bootstrap.yaml) | A provider-named ECR repository with immutable tags and permission for the four project-scoped Lambda functions to pull their image, and an empty Secrets Manager slot for the owner verifier. |
| [Git credential](github-pat.yaml) | The retained projects Git credential slot at `/perottino-co/github/pat`. The owner supplies the value separately. The current runtime has no grant to read it. Reuse its owning stack if it already exists in the destination account and region. |

For a fresh target, create the runtime bootstrap stack with the scope used in hosted synthesis. The Git credential template takes no parameters. Use a distinct stack name for each. For existing stacks, review a change set against the recorded stack instead of creating another copy.

```sh
aws cloudformation create-stack --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK" \
  --template-body file://infra/runtime-bootstrap.yaml --enable-termination-protection \
  --parameters "ParameterKey=ProjectScope,ParameterValue=$PROJECT_SCOPE" --tags file://"$PRIVATE_TAG_FILE"
aws cloudformation wait stack-create-complete --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK"
aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$BOOTSTRAP_STACK" --query 'Stacks[0].Outputs'
```

Before initializing owner access, check the owner slot's version metadata. For a new installation, use the owner setup command with a temporary protected `DATA_DIR` and a password supplied on stdin. Save the resulting `owner.json` as the bootstrap `OwnerSecretArn`'s value from a protected file. This JSON contains only `username` and the salted Argon2id `passwordHash`. Preserve existing secrets across ordinary releases. The PAT is independent of sign-in, browser and model access.

## Publish and synthesize

Run the [publisher](../scripts/publish-images.sh) with Git, AWS CLI v2 and Docker Buildx on the release runner. It verifies the destination account and registry, publishes Linux x86_64 worker and Lambda images from the selected commit, and prints the destination manifest digests. Account for ECR storage when retaining older images for rollback. Use a system-installed Buildx plugin and the default engine or an explicit `DOCKER_HOST`. For a TLS-intercepting build environment the public trust certificate can be supplied through `BUILD_CA_FILE`.

```sh
TARGET_ACCOUNT="$DESTINATION_ACCOUNT" AWS_REGION="$DESTINATION_REGION" \
  BOOTSTRAP_STACK="$BOOTSTRAP_STACK" bash scripts/publish-images.sh > "$PRIVATE_IMAGES_JSON"
npm ci
npm run synth:hosted -- --config "$HOSTED_CONFIG" --provenance "$PRIVATE_PROVENANCE" --outdir "$PRIVATE_ASSEMBLY"
```

Fill the private hosted configuration with `workerImage` and `lambdaImage` from the publisher, the owner secret ARN, matching subnet and role configuration, and the permitted model and browser resources. See [the synthetic example](example-hosted.json). The release runner needs permission to push to the specific ECR repository. The deployer needs scoped creation rights for the resources in the synthesized template, including `iam:PassRole` for the declared roles. Prepare the ECS service-linked role in accounts that restrict AWS service-linked role creation.

## Review and execute the change set

Use `artifacts.Hosted.properties.stackName` from the generated assembly manifest as `HOSTED_STACK`, and supply its tags. Choose `CREATE` for a fresh stack and `UPDATE` for a subsequent release. Preserve the production table identity, stream mapping and stored conversations. Do not execute a template that would inadvertently replace durable state.

```sh
aws cloudformation create-change-set --region "$AWS_REGION" --stack-name "$HOSTED_STACK" \
  --change-set-name "$RELEASE_ID" --change-set-type "$CHANGE_TYPE" \
  --template-body file://"$PRIVATE_ASSEMBLY/Hosted.template.json" \
  --capabilities CAPABILITY_NAMED_IAM --tags file://"$PRIVATE_TAG_FILE"
aws cloudformation wait change-set-create-complete --region "$AWS_REGION" \
  --stack-name "$HOSTED_STACK" --change-set-name "$RELEASE_ID"
aws cloudformation describe-change-set --region "$AWS_REGION" \
  --stack-name "$HOSTED_STACK" --change-set-name "$RELEASE_ID"
```

If the private template exceeds CloudFormation's 51,200-byte inline limit, stage it under a versioned key in the account's private release bucket and supply its HTTPS S3 URL with `--template-url`. Execute the reviewed named change set when a deployment is authorized. Wait for stack completion, enable termination protection, and keep stack IDs, target configuration, secret references, source SHA and image digests in the private inventory.

The new hosted stack has a different name from the earlier single-host design. The original account has only the separate Git credential stack. If another installation ran the old stack, its SQLite data and suspended work require a separately verified migration before traffic cutover. Preserve the source and backup, and test import and rollback before switching DNS. This release does not perform an automatic cross-store migration or delete existing resources.

## Cost at pilot scale

These are US East (N. Virginia) public on-demand rates checked on November 26, 2026, before credits or taxes. The number of directory entries does not set the compute bill. With the console closed and no queued jobs, the system runs zero employee tasks and starts zero browser sessions.

| Usage driver | How to estimate |
| --- | --- |
| Fargate worker | The lean Linux x86 size is 0.25 vCPU and 1 GB. At $0.000011244 per vCPU-second and $0.000001235 per GB-second, compute costs about $0.01457 per task-hour. Billing starts at image download, with a one-minute minimum. [Fargate pricing](https://aws.amazon.com/fargate/pricing/) |
| Temporary public IPv4 | Budget $0.005 per address-hour during the task's IP allocation, with a one-minute minimum. A simple estimate for 1,000 tasks using **five billed minutes each** is **$1.63 for worker compute plus IPv4**. Retries add billable launches. [VPC pricing](https://aws.amazon.com/vpc/pricing/) |
| Control plane | HTTP API starts at $1 per million requests. Lambda x86 charges $0.20 per million requests plus duration. Step Functions Standard charges $0.000025 per transition. Its waits release compute. Rechecking a busy employee adds transitions, Lambda calls and DynamoDB reads. A foreground owner tab polls every minute when idle and every 2.5 seconds while work is pending. Hidden tabs suspend polling. [API Gateway](https://aws.amazon.com/api-gateway/pricing/) · [Lambda](https://aws.amazon.com/lambda/pricing/) · [Step Functions](https://aws.amazon.com/step-functions/pricing/) |
| Durable records and images | Budget $0.40 per retained Secrets Manager secret per month, or $0.80 for the owner and Git slots together, plus read charges. Private ECR storage is $0.10 per GB-month. DynamoDB on-demand reads and writes, storage, point-in-time recovery, S3 failure archives and log storage depend on usage. [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) · [ECR](https://aws.amazon.com/ecr/pricing/) · [DynamoDB](https://aws.amazon.com/dynamodb/pricing/) |
| Model and browser | Price actual Bedrock input/output tokens for the selected model, and actual AgentCore Browser session memory and active CPU. These are separate from the $1.63 example. [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) · [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) |
| Domain and network | The default execute-api hostname is included. An existing Route 53 zone adds no second hosted-zone fee. A new standard hosted zone generally starts at $0.50 per month. Account for applicable egress, DNS and log ingestion. [Route 53 pricing](https://aws.amazon.com/route53/pricing/) |

A first chat reply includes workflow and Fargate cold-start time. Record time to first reply, billed task seconds, token counts and browser usage in a live pilot before forecasting a company-wide monthly total.
