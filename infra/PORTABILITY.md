# Release into a target AWS account

The release runner builds the images and prepares the CloudFormation change set. The owner needs no development machine. The active hosted stack uses a managed HTTPS API, Lambda functions, DynamoDB, EventBridge and one standalone Fargate task per active employee. The target supplies its own account, public subnet, permissions boundary and Bedrock access. [Architecture, cost and recovery](HOSTED.md)

## Select the target

Use a reviewed source revision and a scoped AWS commercial-region deployment identity. Confirm its account and region with STS before creating resources. Use a private copy of the [provenance example](example-provenance.json) and retain the original creation metadata on updates. The derived scope is the project UUID, a hyphen and the environment name. Supply the complete resulting tag set, including `factory:s`, as a private CloudFormation JSON array of `Key` and `Value` records. Stack and function names, model access, browser availability and image digests are specific to the target.

Select public IPv4 subnets in the specified VPC with working DNS and an internet-gateway default route. Fargate assigns a temporary public IPv4 address to the running task for ECR, Bedrock and permitted outbound requests. Its security group has no inbound rules. The API and orchestration Lambdas use the Lambda-managed network. The standard API Gateway HTTPS URL works without a custom domain, hosted zone, certificate, load balancer or NAT gateway.

Bedrock Runtime authorizes each Responses API request against both the inference target and the account's regional default project. The worker role grants invocation on the configured profile and destination models. Its separate `bedrock:InvokeModel` grant on `arn:aws:bedrock:<region>:<account>:project/default` has a `bedrock:ModelArn` condition matching the exact profile. The template derives the default project ARN from the target account and region. [AWS Responses API permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html#bedrock-mantle-responses-runtime)

For a Marketplace-backed model, have a subscription-authorized account operator activate the model in the destination account. Confirm access with a native worker reply after activation. AWS can allow initial requests while its background subscription is pending, so one successful response can precede a later access denial. Keep Marketplace subscription permissions with the operator. [Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)

### Optional project-owned network

If the target has no suitable shared network, create a separate stack from the [pilot network template](pilot-network.yaml). Set `AvailabilityZoneA` and `AvailabilityZoneB` to distinct standard AZ names in the target account and region. Use an unused, aligned RFC 1918 `VpcCidr` of size /22. The default `10.230.0.0/22` produces `10.230.0.0/23` and `10.230.2.0/23`, each with 507 assignable addresses. The stack creates one internet gateway and a shared public route. The employee factory explicitly requests a public IPv4 address when it starts each task. This network requires no NAT gateway, load balancer or public DNS changes.

Pass the complete project provenance through the stack’s `--tags` option at creation and on updates. CloudFormation propagates stack tags to taggable VPC, gateway, subnet and route-table resources. After `CREATE_COMPLETE`, record the stack outputs privately. Set `vpcId` to `VpcId` and `publicSubnetIds` to [`PublicSubnetA`, `PublicSubnetB`] in the hosted configuration. Preserve these CIDR and zone inputs across releases while employees use the network.

## Bootstrap once per target

| Template | What it provisions |
| --- | --- |
| [Runtime bootstrap](runtime-bootstrap.yaml) | A provider-named ECR repository with immutable tags and permission for the project-scoped console, factory and optional mail functions to pull their image, and an empty Secrets Manager slot for the owner verifier. |
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

Use `artifacts.Hosted.properties.stackName` from the generated assembly manifest as `HOSTED_STACK`, and supply its tags. Choose `CREATE` for a fresh stack and `UPDATE` for a subsequent release. Preserve the production table identity and stored conversations. For an upgrade from per-turn execution, pause writes and finish outstanding workflow executions before enabling the resident runtime. Review any in-flight side effects and keep a recovery point for the retained table. Do not execute a template that would inadvertently replace durable state.

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

Monthly estimates below use 730 hours at US East (N. Virginia) Linux x86 on-demand rates, before credits or taxes. Each active employee runs continuously, including while waiting for work. A paused employee stops incurring task compute and public IPv4 charges when Fargate releases those resources.

| Active employees | Fargate compute | Public IPv4 | Monthly subtotal |
| ---: | ---: | ---: | ---: |
| 1 | $10.63 | $3.65 | $14.28 |
| 2 | $21.27 | $7.30 | $28.57 |
| 30 | $318.99 | $109.50 | $428.49 |
| 100 | $1,063.29 | $365.00 | $1,428.29 |

Each task uses 0.25 vCPU and 1 GB. Compute is `3600 × (0.25 × $0.000011244 + $0.000001235)` per hour. Public IPv4 is $0.005 per address-hour. Subtotals use unrounded rates. [Fargate pricing](https://aws.amazon.com/fargate/pricing/) · [VPC pricing](https://aws.amazon.com/vpc/pricing/)

Add Bedrock tokens, AgentCore Browser sessions, on-demand DynamoDB reads on pulses, writes/checkpoints, backups, HTTP API, Lambda, EventBridge where applicable, logging, data transfer, image storage and any enabled mail infrastructure. The model and browser incur charges as used. The retained owner and Git credential slots together cost about $0.80 per month plus reads. Measure dwell time, model calls per completed assignment, and end-to-end response latency in a live pilot. [DynamoDB](https://aws.amazon.com/dynamodb/pricing/) · [Bedrock](https://aws.amazon.com/bedrock/pricing/) · [AgentCore](https://aws.amazon.com/bedrock/agentcore/pricing/) · [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/)

The optional SES ingress stack takes the hosted table name and the same Lambda image digest. Release it separately when a company receiving domain is ready. [Inbound mail setup](INBOUND-EMAIL.md)
