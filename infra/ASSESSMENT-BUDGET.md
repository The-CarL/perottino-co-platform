# $100 monthly assessment

Use three Linux x86 Fargate seats including the CEO, small workers at 0.25 vCPU and 1 GiB each, and one $30 company wallet. Set `employeeLimit: 3` and `workerSize: "small"` in the private hosted configuration. The factory reserves a seat in DynamoDB before ECS RunTask. Bootstrap starts one CEO. The hosted configuration and durable factory control row should both report three seats. At the US East (N. Virginia) on-demand rates of $0.04048 per vCPU-hour, $0.004445 per GiB-hour and $0.005 per public IPv4-hour, three residents continuously running for a 744-hour month cost approximately $43.67 for these components. Minimum task billing periods and overlapping replacements can change the actual charge. Pause the company when idle work should stop. [Fargate pricing](https://aws.amazon.com/fargate/pricing/) · [Public IPv4 pricing](https://aws.amazon.com/vpc/pricing/)

Set the owner policy to `totalBudgetCents: 3000` once for the whole company. A transfer moves an existing balance to an employee. The wallet has no monthly refill. For the US Geo Standard GPT-6.2 Sol profile, set the trusted tariff to the following conservative envelope. The largest input rate includes long-context cache writes. The meter uses the same input ceiling for ordinary and cached tokens. A single attempt reserves $7.89 and consumes funds at these policy rates after receiving token usage, or consumes the entire hold if usage is unknown. Each employee running a paid decision needs an available balance at least this large. A $30 wallet can fund three simultaneous maximum holds, subject to their distribution. [AWS model card and regional prices](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-2-sol.html)

```json
{
  "modelTariffs": {
    "us.openai.gpt-6.2-sol": {
      "maxInputTokens": 1050000,
      "maxOutputTokens": 128000,
      "inputCentsPerMillion": 550,
      "outputCentsPerMillion": 1650
    }
  }
}
```

Set `browserMinutesPerMonth: 200` in the hosted configuration to give the whole assessment a shared 200-minute allowance each UTC month. The broker reserves the maximum session time before contacting AgentCore, 15 minutes for interactive sessions and 90 seconds for document reads. Early stops and uncertain starts consume their reservations. A session that could cross a month boundary reserves time in both months. During the original 30-second admission window, a retry of an interactive start reuses its provider token without another charge to the allowance. The operator can read the remaining allowance with `browser.usage`. Removing this optional configuration restores the default direct document reader on employee tasks.

At full steady occupancy the $43.67 resident estimate plus the $30 wallet leaves $26.33 of the $100 assessment for other charges. The wallet meters model calls and fixed build-attempt charges. Browser time, public API traffic, data transfer, DynamoDB, logs, traces, storage, mail and other AWS services bill separately. Review billing during the assessment and pause early enough to allow for delayed charges. The separate cloud budget sends notifications. It cannot guarantee a $100 invoice ceiling. [AWS Budgets update timing](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html)

## Install the billing alert

A billing administrator can install the optional template in the payer's billing context in US East (N. Virginia). Keep the alert address and the exact deployment scope in private configuration. This monitoring budget has no Budget Actions or purchase commitments. [Template](assessment-budget.yaml) · [AWS Budgets pricing](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/)

1. Confirm each assessment stack and supported billable resource carries `perottino:assessment=<project UUID>-<environment>`. Check propagated running-task tags. AWS may take up to 24 hours to list a new tag key for activation.
2. Open **Billing and Cost Management → Cost allocation tags** in the payer account. Select the user-defined key `perottino:assessment`, choose **Activate**, and confirm it eventually shows **Active**. Billing tag activation applies to the key wherever it is used in the account. This key is dedicated to the Perottino assessment. AWS may take up to another 24 hours to activate it. [AWS activation guide](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html)
3. Create a CloudFormation stack from the linked template. Supply the exact tag value as `Scope` and the alert recipient as `NotificationEmail`. Record the stack ID and verify the budget's $100 monthly limit, single tag-value filter, recipient and three notifications. The thresholds are actual spend above 70%, forecast above 100%, and actual spend above 100%. The filter excludes refunds and credits from the consumption measure. [AWS CLI tagged-budget example](https://docs.aws.amazon.com/cli/latest/userguide/cli_budgets_code_examples.html)
4. Once billing data arrives, compare the tag-filtered spending with the wallet and relevant service totals. Some service-generated or shared charges have no workload tag. The default system Bedrock inference profile does not inherit tags from the ECS worker. Token-level attribution for that profile comes from the application ledger, or from a separately configured Bedrock application inference profile with cost allocation tags. Forecasts may be unavailable until the billing dataset has enough history. [Bedrock cost attribution](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html) · [AWS Budgets forecasting](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-best-practices.html)
