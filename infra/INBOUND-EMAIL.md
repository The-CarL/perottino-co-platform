# Receive company email

The optional mail stack attaches one domain-specific receipt rule to a target account’s active SES receipt rule set. SES sends the scanned MIME message to an SNS topic. A Lambda function resolves the envelope recipients in the directory and appends each message to the appropriate durable inbox. The resident employee sees the message on a subsequent pulse. A paused employee keeps queued mail until resumed.

`mara@<company-domain>` and `ceo@<company-domain>` both reach Mara. Every employee has a personal handle. A role label also resolves if exactly one current employee has it, with words joined by hyphens. A personal handle takes precedence over a matching role alias. Receipt IDs prevent duplicate delivery to the same employee. Unknown addresses and failed SES spam or virus verdicts are ignored. The display sender comes from the message envelope and carries external authority. The owner console is the entry point for authenticated directions.

## Deploy to a receiving domain

Use a private target configuration with a receiving-enabled SES region, a verified company domain, and the intended active receipt rule set. Review existing rule order for catch-all or stop actions. The template manages the single company rule, SNS topic, mail Lambda, scoped role, logs and failure queue. Account-wide rule-set activation, domain verification and DNS ownership are target prerequisites. Use the existing named rule set and the same region as the hosted employee table. [SES receiving regions and MX endpoints](https://docs.aws.amazon.com/ses/latest/dg/regions.html)

After deploying the hosted company stack, supply these CloudFormation parameters to the [inbound template](inbound-email.yaml) in a separate stack with the same private provenance tags.

| Parameter | Value |
| --- | --- |
| `ProjectScope` | The hosted deployment’s project scope |
| `MailDomain` | Dedicated company subdomain, such as `co.example.org` |
| `ActiveReceiptRuleSet` | Existing active receipt rule set |
| `StateTableName` | Hosted stack output of the same name |
| `LambdaImage` | The same immutable Lambda image digest as the hosted release |
| `PermissionsBoundaryArn` | Target account’s approved permissions boundary |

Create and review the change set with `CAPABILITY_IAM`. The runtime bootstrap registry policy must include the company’s `-r-e` Lambda. When ready to receive mail, route the dedicated subdomain’s MX record to the SES inbound endpoint for the selected region, using priority 10. Preserve the parent domain’s mail routing. Test an external delivery to both CEO aliases and confirm one inbox item for a single message sent to both. Repeat for a named hire. [SES setup](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html)

The SES SNS action accepts messages up to 150 KB including headers. The inbox stores the decoded subject, envelope sender and recipient, provider receipt ID, and up to 12,000 characters of plain text. Attachments and the full raw message are outside the inbox record. An email is external input even if its From address resembles the owner. Outbound SMTP and threaded delivery are a separate implementation milestone. [SES SNS action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html)

The encrypted failure queue retains unsuccessful SNS deliveries and Lambda invocation failures for 14 days. Restrict operator access because a failed event can include the original message. After fixing a failure, replay the original SNS event to the ingress function under an authorized operator role, preserving the original receipt ID. Monitor visible messages and oldest-message age for this queue during a pilot.
