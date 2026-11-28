# Company email

The optional SES stack gives employees addresses on one company subdomain. An employee can compose mail and reply from their authenticated workspace. The owner can select an employee in **Mail** to inspect correspondence or send on that employee’s behalf. Messages between employees on the company domain stay in the company store. Incoming and outgoing external mail appear in those same threaded mailboxes.

A personal handle such as `mara@staff.example.org` identifies an employee. `ceo@staff.example.org` resolves to the CEO. A role such as `software-engineer@staff.example.org` works when exactly one current employee holds it. Personal handles take precedence. Paused employees receive mail for later work. A fired employee retains a readable archive. One message addresses one recipient. An inbound message copied to several employees creates a separate correspondence with each, and duplicate aliases for one employee resolve once.

The company stores plain text and bounded threading metadata. SES accepts up to 150 KB with this SNS receiving action, including headers and attachments. The adapter keeps the subject and up to 12,000 characters of inbound text. Attachments are omitted. Replies bind to the other participant on the stored thread. The adapter ignores a sender-supplied Reply-To when choosing an external recipient and sets In-Reply-To and References for outgoing replies. It looks up original messages by RFC Message-ID and correlates SES-assigned outbound IDs with the original employee and external address. [SES SNS action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html)

## Prepare the company subdomain

The [mail domain template](mail-domain.yaml) provisions a regional Easy DKIM identity on a child label of the parent domain. With the public parent hosted zone ID it publishes the three SES CNAMEs. For separately managed DNS, leave the zone ID empty and copy all three names and values from the SES identity to the authoritative DNS provider. Check for conflicting records before applying a change set. The default leaves MX unpublished while the receiving path is being prepared.

Read the regional active receipt rule set before provisioning. An existing set can accept a rule scoped exclusively to the company subdomain. If the region has no active set or other receiving workload, supply a unique `NewRuleSetName` to provision an inactive dedicated set. Deploy the mail stack against that name, verify its Lambda subscription and rule, then recheck the active regional set. Activate the dedicated set only if the region still has no active set, and wait for the company identity's DKIM verification to succeed. Finally set `PublishMx=true` in the domain stack or publish the subdomain MX through your DNS provider. This sequence covers initial delivery and preserves shared zone and receipt settings.

## Deploy the optional mail stack

Use the same receiving-enabled SES region as the hosted company table. Verify a dedicated sending and receiving domain, publish the provided DKIM records, and identify the existing active receipt rule set. Inspect its order for catch-all or stop actions. While the SES account is in the sandbox, use verified external recipients. Production access is required for general external delivery. Domain verification, DNS ownership and SES production access are operator actions. [Receiving regions](https://docs.aws.amazon.com/ses/latest/dg/regions.html) · [SES identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [Production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

Create and review a change set with `CAPABILITY_IAM` for [the mail template](inbound-email.yaml). Use the company's existing private provenance tags.

| Parameter | Value |
| --- | --- |
| `ProjectScope` | Scope of the target hosted company |
| `MailDomain` | The dedicated SES-verified subdomain |
| `ActiveReceiptRuleSet` | Name of the region’s existing active receipt rule set |
| `StateTableName` | Hosted stack output of that name |
| `LambdaImage` | Immutable Lambda image digest from the same release as the company |
| `PermissionsBoundaryArn` | Approved permissions boundary for the two scoped mail roles |
| `OwnerMailSecretArn` | Optional ARN of an existing Secrets Manager secret for privileged founder mail |
| `EnableFounderSandboxDelivery` | Enable after SES verifies the enrolled founder address in this region. Defaults to `false`. |

The runtime image repository must permit Lambda image retrieval for suffixes `-r-e` and `-r-s`. The mail stack creates one SES receipt rule, two SNS topics, an SES configuration set and event destination, two Lambda functions with separate execution roles, a one-minute scheduled outbox drain, bounded-retention logs and a 14-day encrypted failure queue. The sender’s SES permission is scoped to the company identity and configuration set with a From-address condition. Employee tasks have no SES credentials or send permission. The sender checks active employment and the company run gate when it claims an outbound send.

In the hosted company configuration set `mailDomain` to the same verified domain and enable `mailOutbound` when the mail stack is ready. This gives the owner API and worker broker `PEROTTINO_MAIL_DOMAIN` and `PEROTTINO_MAIL_OUTBOUND=1`. Route only the dedicated subdomain’s MX to the regional SES inbound endpoint, normally at priority 10. Confirm mailbox routing and one verified recipient before general operation. [SES receiving setup](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html)

## Founder instructions with a normal mail client

Deploy [the founder credential template](founder-mail-secret.yaml) as a separate stack in the mail stack's account and region. Supply the exact founder mailbox in its masked `FounderEmail` parameter using a private deployment context. The parameter accepts a single email address. Keep enrollment inputs and the change set accessible only to authorized operators.

Secrets Manager generates a 52-character routing token from lowercase letters and digits 2–7 and stores it with the enrolled address. The alphabet provides 260 bits of random choice. The stack exposes only `OwnerMailSecretArn`. Pass that output to the mail stack's parameter of the same name. Preserve the credential stack across runtime releases. Unrelated updates preserve the current token. Changing the founder address or generator settings creates a new secret version and requires a new contact handoff.

For outbound replies from a sandboxed SES account, check the enrolled mailbox with `sesv2 get-email-identity` in the sending region. Reuse an existing verified identity and wait for an existing pending verification. If the identity is absent and the founder authorizes a verification email, set `VerifySandboxRecipient=true`, keeping the existing `FounderEmail` parameter. Review the change set for the addition of `FounderRecipient`. SES sends its verification link when CloudFormation creates this retained identity. The founder follows the link in their mailbox. Confirm `VerifiedForSendingStatus=true` before testing a reply. SES and CloudFormation operators can see the address as the identity name. [SES identity verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)

For enrollment, an authorized owner or credential operator opens the secret in Secrets Manager and saves `owner-<token>@<mail-domain>` as the CEO contact in the founder's private address book or password manager. Use a protected, one-to-one handoff if another operator performs enrollment. Keep the token and private address out of deployment output, company chat, shared files, and logs. For ordinary correspondence, continue using the public employee address.

For a sandbox deployment, update the mail stack with `EnableFounderSandboxDelivery=true` after verification. CloudFormation resolves the enrolled `address` field into the sender's IAM policy. The additional grant covers that recipient's SES identity and requires every destination to match that address and the From address to belong to the company domain. The sender explicitly selects the verified domain identity when sending. Disable the grant when leaving the sandbox. If the founder address changes, disable the grant, verify the new recipient and re-enable it to refresh the resolved IAM policy.

The founder emails the private contact from the enrolled mailbox. The ingress requires the capability, exactly one matching MIME From, and passing SES DKIM and DMARC verdicts. It stores the CEO’s public handle as the recipient and supplies the worker a verified owner flag. Only the dedicated ingress and SES sender receive workload access to this secret. Restrict access to raw SNS failure events, forwarded founder messages and reply headers because they can contain the private routing address. For deliberate rotation, update the secret with an independently generated token in the same format and replace the founder's saved contact.

A reply to a verified instruction uses the original public office or employee From while that employee retains the alias. The SES adapter places the private founder address in Reply-To only on the CEO's verified thread with the enrolled mailbox. Normal email clients can therefore reply on the same thread weeks later. Rotating the token invalidates the previous private Reply-To, and the founder can manually select the new private contact when replying.

Mail sent to public aliases is ordinary correspondence. The worker can answer the original sender or pass. It receives no hiring or work authority from that mail. Unauthenticated ordinary mail remains visible for review. Automatic notices and bounces do not wake a responder. A goal created from verified founder mail can retain its private source. When all work passes review, the accountable employee’s completion notice carries its explicitly written requester reply to the original private correspondence. Task evidence and internal notes remain in the work system.

## Delivery and recovery

When external mail is due, the hosted sender checks whether SES has verified the configured company domain for sending. A pending domain or a failed lookup leaves the message queued with its send attempt count unchanged. The sender caches the result for 30 seconds. The one-minute drain resumes delivery automatically after verification. Idle drains make no SES requests.

Each send commits the message, thread, employee indexes and durable intent before SES runs. SES is called with one SDK attempt and a tagged message ID. A successful response marks the message sent, and SES event publication records delivery, bounce, complaint or rejection. Internal company mail is committed directly. Local mode uses the same authorization, threading, claiming and receipt transitions and captures external envelopes in SQLite without opening a network connection. [SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications-event-publishing.html)

Company activity records each received message, queued outbound message, dispatch attempt and status transition in the same transaction as the mail change. A dispatch event marks the start of an attempt. A sent or delivered status records the corresponding provider confirmation. Each activity entry carries internal thread, message, actor and employee identifiers. Owner reads of company folders and employee threads also produce audit entries. Correspondents, subjects, bodies and routing secrets stay in the restricted mail records.

The sender retries explicit throttling with bounded backoff. A timeout, ambiguous network error, or lost worker after an intent was claimed marks the message **uncertain**. Later tagged SES events reconcile it. An uncertain message is not automatically submitted again. Review the status, SES events and failure queue before deliberately creating a new send. Replaying the same owner or worker request ID returns the original message. SNS or Lambda failures can include the original message and the founder routing address. Restrict access to the failure queue, inspect it privately and replay the original provider event after correcting the cause.

Run the mail, SES adapter and completion-notice tests with `node --test test/company-mail.test.mjs test/email-ingress.test.mjs test/company-notifications.test.mjs`. The fixtures verify real SQLite records, internal aliases, RFC threads, sender-bound replies, owner verification, recovery and the SES request structure. A live external round trip additionally requires the domain, target account and verified or production-enabled recipient.
