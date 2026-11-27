# Company email

The optional SES stack gives employees addresses on one company subdomain. An employee can compose mail and reply from their authenticated workspace. The owner can select an employee in **Mail** to inspect correspondence or send on that employee’s behalf. Messages between employees on the company domain stay in the company store. Incoming and outgoing external mail appear in those same threaded mailboxes.

A personal handle such as `mara@staff.example.org` identifies an employee. `ceo@staff.example.org` resolves to the CEO. A role such as `software-engineer@staff.example.org` works when exactly one current employee holds it. Personal handles take precedence. Paused employees receive mail for later work. A fired employee retains a readable archive. One message addresses one recipient. An inbound message copied to several employees creates a separate correspondence with each, and duplicate aliases for one employee resolve once.

The company stores plain text and bounded threading metadata. SES accepts up to 150 KB with this SNS receiving action, including headers and attachments. The adapter keeps the subject and up to 12,000 characters of inbound text. Attachments are omitted. Replies bind to the other participant on the stored thread. The adapter ignores a sender-supplied Reply-To when choosing an external recipient and sets In-Reply-To and References for outgoing replies. It looks up original messages by RFC Message-ID and correlates SES-assigned outbound IDs with the original employee and external address. [SES SNS action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-sns.html)

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

The runtime image repository must permit Lambda image retrieval for suffixes `-r-e` and `-r-s`. The mail stack creates one SES receipt rule, two SNS topics, an SES configuration set and event destination, two Lambda functions with separate execution roles, a one-minute scheduled outbox drain, bounded-retention logs and a 14-day encrypted failure queue. The sender’s SES permission is scoped to the company identity and configuration set with a From-address condition. Employee tasks have no SES credentials or send permission. The sender checks active employment and the company run gate when it claims an outbound send.

In the hosted company configuration set `mailDomain` to the same verified domain and enable `mailOutbound` when the mail stack is ready. This gives the owner API and worker broker `PEROTTINO_MAIL_DOMAIN` and `PEROTTINO_MAIL_OUTBOUND=1`. Route only the dedicated subdomain’s MX to the regional SES inbound endpoint, normally at priority 10. Confirm mailbox routing and one verified recipient before general operation. [SES receiving setup](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html)

## Founder instructions with a normal mail client

Provision a private Secrets Manager JSON value containing `address` and `token`. Set `address` to the founder's exact email address. To generate `token`, encode 32 cryptographically random bytes as unpadded lowercase RFC 4648 base32. This produces 52 characters from letters a–z and digits 2–7. The following command writes a new private file in an operator-owned directory. It displays no credential and refuses an existing filename.

```sh
python3 - <<'PY'
import base64, json, os, secrets
address = os.environ["OWNER_MAIL_ADDRESS"]
token = base64.b32encode(secrets.token_bytes(32)).decode("ascii").rstrip("=").lower()
with os.fdopen(os.open("owner-mail.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
    json.dump({"address": address, "token": token}, f)
PY
```

Set `OWNER_MAIL_ADDRESS` privately before running the command and enroll the file's contents in the specified secret using your approved secret-provisioning procedure. Share the derived contact address `owner-<token>@<mail-domain>` only with the founder. The owner sends an ordinary email from the enrolled mailbox to that private contact. The ingress requires the capability, exactly one matching MIME From, and passing SES DKIM and DMARC verdicts. It stores the CEO’s public handle as the recipient and supplies the worker a verified owner flag. The optional founder secret is read only by the dedicated ingress and SES sender. Treat email forwarded from the founder's mailbox, raw SNS failure events and reply headers as sensitive because these can include the private address. To rotate it, replace the secret’s token and update the founder’s private contact.

A reply to a verified instruction uses the original public office or employee From while that employee retains the alias. The SES adapter places the private founder address in Reply-To only on the CEO's verified thread with the enrolled mailbox. Normal email clients can therefore reply on the same thread weeks later. Rotating the token invalidates the previous private Reply-To, and the founder can manually select the new private contact when replying.

Mail sent to public aliases is ordinary correspondence. The worker can answer the original sender or pass. It receives no hiring or work authority from that mail. Unauthenticated ordinary mail remains visible for review. Automatic notices and bounces do not wake a responder. A goal created from verified founder mail can retain its private source. When all work passes review, the accountable employee’s completion notice carries its explicitly written requester reply to the original private correspondence. Task evidence and internal notes remain in the work system.

## Delivery and recovery

Each send commits the message, thread, employee indexes and durable intent before SES runs. SES is called with one SDK attempt and a tagged message ID. A successful response marks the message sent, and SES event publication records delivery, bounce, complaint or rejection. Internal company mail is committed directly. Local mode uses the same authorization, threading, claiming and receipt transitions and captures external envelopes in SQLite without opening a network connection. [SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications-event-publishing.html)

The sender retries explicit throttling with bounded backoff. A timeout, ambiguous network error, or lost worker after an intent was claimed marks the message **uncertain**. Later tagged SES events reconcile it. An uncertain message is not automatically submitted again. Review the status, SES events and failure queue before deliberately creating a new send. Replaying the same owner or worker request ID returns the original message. SNS or Lambda failures can include the original message and the founder routing address. Restrict access to the failure queue, inspect it privately and replay the original provider event after correcting the cause.

Run the mail, SES adapter and completion-notice tests with `node --test test/company-mail.test.mjs test/email-ingress.test.mjs test/company-notifications.test.mjs`. The fixtures verify real SQLite records, internal aliases, RFC threads, sender-bound replies, owner verification, recovery and the SES request structure. A live external round trip additionally requires the domain, target account and verified or production-enabled recipient.
