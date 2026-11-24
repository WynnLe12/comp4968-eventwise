# Timeline Lambdas deployment guide — Feature 13

Step-by-step console checklist for deploying the event timeline: one DynamoDB table, one SQS queue (plus DLQ), three Lambda functions from one ZIP, API Gateway routes, an EventBridge schedule and SES identities. API contract: [timeline.md](timeline.md). Table design: [database/dynamodb/timeline.md](../../database/dynamodb/timeline.md).

Work in **US West (Oregon) us-west-2** throughout. IAM is global; its CloudTrail events appear under N. Virginia, but every resource below is created in Oregon.

## 1. What gets deployed

| Resource | Name | Notes |
| --- | --- | --- |
| DynamoDB table | `EventWise_Timeline` | + GSI `ReminderIndex` |
| SQS queue | `eventwise-timeline-emails` | + DLQ `eventwise-timeline-emails-dlq` |
| Lambda (API) | `eventwise-timeline` | Handler `timeline-service/lambda/timeline.handler`. In the RDS VPC |
| Lambda (reminders) | `eventwise-timeline-reminders` | Handler `timeline-service/lambda/reminders.handler`. In the RDS VPC |
| Lambda (email sender) | `eventwise-timeline-email-sender` | Handler `timeline-service/lambda/emailSender.handler`. **Not** in a VPC |
| API Gateway | REST API `hd63bpgxm8`, stage `prod` | 5 new resources under `/events/{eventId}/timeline` + `/guest-timeline/{share}` |
| EventBridge Scheduler | `eventwise-timeline-reminders-every-5-min` | `rate(5 minutes)` → reminders Lambda |
| SES identities | sender + demo recipients | Account is in the SES sandbox |

All three functions use the same `backend/build/eventwise-timeline.zip`.

### Network (checked Nov 23)

The default VPC `vpc-0a29df84c9e10f13e` has **no NAT gateway**. The two VPC Lambdas reach everything through existing endpoints, so no network changes are needed:

| Needs | Through |
| --- | --- |
| RDS MySQL | `eventwise-rds-sg` allows 3306 from `eventwise-lambda-sg` |
| Secrets Manager | `eventwise-secrets-endpoint` (interface) |
| DynamoDB | Gateway endpoint in the main route table `rtb-09e5afcfdad17e641` |
| SQS | `eventwise-sqs-endpoint` (interface, private DNS on); `eventwise-sqs-endpoint-sg` allows 443 from `eventwise-lambda-sg` |

Neither VPC Lambda calls Cognito or SES. Organizer emails come from ID tokens verified offline against `certs/cognito-jwks.json` (bundled in the ZIP). Only the email sender, outside the VPC, talks to SES.

## 2. Before you start

1. Build the ZIP on the feature branch:

   ```bash
   cd backend
   npm ci
   npm run typecheck && npm test
   npm run package:timeline
   ```

   It must end with `Timeline package smoke checks passed`. Upload `backend/build/eventwise-timeline.zip` (about 8 MB). The handlers are at the ZIP root; don't re-zip it inside a folder.

2. Generate the guest-link secret (keep it out of Git, Discord and screenshots):

   ```bash
   openssl rand -base64 48
   ```

   The same value goes into `TIMELINE_SHARE_SECRET` on **both** VPC Lambdas. Changing it later breaks every guest link and QR code already shared.

3. Copy these from the `eventwise-events` function (**Configuration → Environment variables** and **Configuration → VPC**): `DB_SECRET_ARN`, `DB_HOST`, `DB_NAME`, `DB_PORT`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, the two subnet IDs and the security group (`eventwise-lambda-sg`).

4. Decide the app origin. Until Friday's Amplify deploy use `http://localhost:5173`; afterwards switch to the Amplify URL (section 10).

## 3. DynamoDB table

**DynamoDB → Tables → Create table**

1. Table name `EventWise_Timeline`. Partition key `eventId` (String). Sort key `sk` (String).
2. **Table settings → Customize settings → Capacity mode: On-demand.**
3. **Secondary indexes → Create global index**: partition key `reminderStatus` (String), sort key `reminderAt` (String), index name `ReminderIndex`, attribute projections **All**.
4. Create, wait for **Active**, and copy the table ARN.

## 4. SQS queues

**SQS → Create queue**, type **Standard**, twice:

| Setting | `eventwise-timeline-emails-dlq` (create first) | `eventwise-timeline-emails` |
| --- | --- | --- |
| Visibility timeout | 30 s | **180 s** (6 × the sender's 30 s timeout) |
| Message retention | 14 days | 4 days |
| Encryption | SSE-SQS (default) | SSE-SQS (default) |
| Dead-letter queue | — | Enabled → `eventwise-timeline-emails-dlq`, **Maximum receives 3** |

Copy the main queue's **URL** (for `TIMELINE_EMAIL_QUEUE_URL`) and **ARN** (for IAM).

## 5. SES (sandbox)

**Amazon SES → Identities → Create identity → Email address**, in us-west-2:

1. The sender, e.g. a team address. Use it as `SES_FROM_ADDRESS` (optionally `EventWise <address>`).
2. **Every demo recipient**: each organizer who will turn on timeline emails, and each demo guest's email in the guest list. In the sandbox SES rejects unverified recipients with `MessageRejected`.
3. Click the verification link in each inbox; the identity must show **Verified**.

## 6. IAM roles

Easiest: let each **Create function** generate a role ("Create a new role with basic Lambda permissions"), as the team has done for other services, then add the inline policies below under **IAM → Roles → (role) → Add permissions → Create inline policy → JSON**. Replace `<ACCOUNT_ID>` and the secret ARN.

**`eventwise-timeline` role** — also attach the managed policy `AWSLambdaVPCAccessExecutionRole`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "TimelineTable", "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Timeline" },
    { "Sid": "GuestEmails", "Effect": "Allow", "Action": "dynamodb:Query",
      "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Guests" },
    { "Sid": "DatabaseSecret", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
      "Resource": "<DB_SECRET_ARN>" },
    { "Sid": "QueueEmails", "Effect": "Allow", "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:us-west-2:<ACCOUNT_ID>:eventwise-timeline-emails" }
  ]
}
```

**`eventwise-timeline-reminders` role** — also `AWSLambdaVPCAccessExecutionRole`. Same as above, plus the index:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "TimelineTable", "Effect": "Allow",
      "Action": ["dynamodb:Query", "dynamodb:UpdateItem"],
      "Resource": [
        "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Timeline",
        "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Timeline/index/ReminderIndex"
      ] },
    { "Sid": "GuestEmails", "Effect": "Allow", "Action": "dynamodb:Query",
      "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Guests" },
    { "Sid": "DatabaseSecret", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
      "Resource": "<DB_SECRET_ARN>" },
    { "Sid": "QueueEmails", "Effect": "Allow", "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:us-west-2:<ACCOUNT_ID>:eventwise-timeline-emails" }
  ]
}
```

**`eventwise-timeline-email-sender` role** — attach the managed policy `AWSLambdaSQSQueueExecutionRole`, plus:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "SendTimelineEmail", "Effect": "Allow", "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:us-west-2:<ACCOUNT_ID>:identity/*" }
  ]
}
```

`identity/*` is deliberate for the sandbox: SES also checks permission on each verified *recipient* identity there. Narrow it to the sender identity after production access.

If the queue uses a customer-managed KMS key instead of SSE-SQS, the senders also need `kms:GenerateDataKey` and the receiver `kms:Decrypt` on that key.

## 7. Lambda functions

**Lambda → Create function → Author from scratch**, three times. Then **Code → Upload from → .zip file** with `eventwise-timeline.zip`, and **Runtime settings → Edit → Handler**.

| Setting | `eventwise-timeline` | `eventwise-timeline-reminders` | `eventwise-timeline-email-sender` |
| --- | --- | --- | --- |
| Runtime / arch | Node.js 22.x / x86_64 | Node.js 22.x / x86_64 | Node.js 22.x / x86_64 |
| Handler | `timeline-service/lambda/timeline.handler` | `timeline-service/lambda/reminders.handler` | `timeline-service/lambda/emailSender.handler` |
| Memory / timeout | 256 MB / 20 s | 256 MB / 60 s | 256 MB / 30 s |
| VPC | Default VPC, the two `eventwise-events` subnets, `eventwise-lambda-sg` | Same as API | **None** |
| Reserved concurrency | Team's RDS budget (e.g. 5) | **1** (one run at a time; also caps DB connections) | Leave unreserved |

### Environment variables

| Variable | API | Reminders | Sender | Value |
| --- | :-: | :-: | :-: | --- |
| `TIMELINE_TABLE_NAME` | ✓ | ✓ | | `EventWise_Timeline` |
| `GUESTS_TABLE_NAME` | ✓ | ✓ | | `EventWise_Guests` |
| `TIMELINE_SHARE_SECRET` | ✓ | ✓ | | From section 2 — **same value in both** |
| `GUEST_APP_ORIGIN` | ✓ | ✓ | | `http://localhost:5173` now; Amplify URL after Friday |
| `TIMELINE_EMAIL_QUEUE_URL` | ✓ | ✓ | | Queue URL from section 4 |
| `TIMELINE_CORS_ORIGIN` | ✓ | | | Exact browser origin, e.g. `http://localhost:5173` (one origin only) |
| `DB_SECRET_ARN`, `DB_HOST`, `DB_NAME`, `DB_PORT` | ✓ | ✓ | | Same as `eventwise-events` |
| `DB_CONNECTION_LIMIT` | ✓ | ✓ | | `2` |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | ✓ | | | Same as `eventwise-events` |
| `SES_FROM_ADDRESS` | | | ✓ | Verified sender from section 5 |

Don't set `AWS_REGION` (Lambda provides it), `DYNAMODB_ENDPOINT` (that would point at DynamoDB Local), or any `VITE_*` variable. `COGNITO_JWKS_FILE` and `DB_SSL_CA_FILE` default to the files bundled in the ZIP.

### SQS trigger on the sender

**`eventwise-timeline-email-sender` → Add trigger → SQS** → `eventwise-timeline-emails`:

- Batch size **10**, batch window 0.
- **Report batch item failures: on.** Without it, one bad message makes the whole batch retry and resend emails that already went out.
- Maximum concurrency **2** (keeps under the sandbox's 1 email/second).

## 8. API Gateway

**API Gateway → APIs → (REST API `hd63bpgxm8`) → Resources.** Create the resources under the existing `/events/{eventId}`:

| Resource | Methods | Authorization |
| --- | --- | --- |
| `/events/{eventId}/timeline` | GET, POST | `EventWiseCognitoAuthorizer`, scope `aws.cognito.signin.user.admin` |
| `/events/{eventId}/timeline/{itemId}` | PATCH, DELETE | same |
| `/events/{eventId}/timeline/share` | GET | same |
| `/events/{eventId}/timeline/subscription` | GET, PUT, DELETE | same |
| `/guest-timeline/{share}` (new top-level `/guest-timeline`) | GET | **NONE** (the signed link is the credential) |

For **every** method: Integration type **Lambda function**, **Lambda proxy integration on**, function `eventwise-timeline`. Accept the console's permission prompt and check the added resource policy is scoped to this API.

Also add an **OPTIONS** method with **no authorization** on each of the five resources, proxied to the same function (it answers CORS preflights with 204 and never touches the database).

Notes:
- `share` and `subscription` are literal children next to `{itemId}`; API Gateway prefers literal matches.
- Use the method scope that existing `/events` methods use. An **empty** scope list makes the authorizer expect ID tokens, and every organizer call would then fail with 401.
- Optional but recommended: **Stages → prod → (method) `/guest-timeline/{share}` GET → Override for this method → Throttling**: rate 10, burst 20.

Then **Deploy API → prod**. A deployment publishes everyone's pending API edits too, so post in Discord first.

## 9. EventBridge Scheduler

**Amazon EventBridge → Scheduler → Schedules → Create schedule**:

1. Name `eventwise-timeline-reminders-every-5-min`. Recurring, **rate-based**, `5 minutes`. Flexible time window **Off**.
2. Target **AWS Lambda Invoke** → `eventwise-timeline-reminders`. Payload `{}`.
3. Retry policy: **off** (or 0 retries). The next run five minutes later picks up anything left; retries could overlap runs.
4. Let the console create the execution role.

## 10. After Amplify goes live (Friday)

On both VPC Lambdas, change `GUEST_APP_ORIGIN` to the Amplify URL, e.g. `https://main.d1234abcd.amplifyapp.com` (no trailing path). On `eventwise-timeline`, change `TIMELINE_CORS_ORIGIN` to the same value. Old localhost links in already-sent emails stop working; the QR code dialog always uses the page's own origin.

## 11. Verify end to end

Use the deployed app (or `npm run dev` with the Vite proxy) with a real event you own.

| # | Check | Expected |
| --- | --- | --- |
| 1 | Timeline page loads for the owner and for a co-planner | Empty state, no errors |
| 2 | Sign in as a user who isn't a member and open the event's API URL | 403 |
| 3 | Add an activity 2 hours from now, reminder **1 hour before** | Appears with "1 hour before"; DynamoDB item has `reminderStatus = PENDING` |
| 4 | Edit it in two browser tabs from the same starting version | Second save says someone else changed it, and reloads |
| 5 | **Share with guests** → open the link in a private window | Guest page shows GUESTS activities only, without sign-in |
| 6 | Change the link's last character | "This link doesn't work" |
| 7 | Turn on **Email me timeline updates** | Shows your email; DynamoDB has a `SUBSCRIBER#…` row |
| 8 | Move the activity 30 min with **Email affected people** ticked | Toast "Emailing N people"; email arrives with "Time: … → …" |
| 9 | Wait until the reminder time (or create one due in ~10 min) | Reminder email within about 5 minutes; item shows "Reminder sent" |
| 10 | Delete an activity with the email option | "Removed from the schedule" email |
| 11 | **CloudWatch → Log groups** for all three functions | Count lines only, e.g. `Timeline reminders: {"due":1,"sent":1,…}`; no addresses |
| 12 | SQS DLQ | Empty |

## 12. Troubleshooting

| Symptom | Check first |
| --- | --- |
| Handler not found / 502 | Correct ZIP (not a re-zip), handler path, Node.js 22.x |
| Every organizer call 401 from Gateway | Method scope missing or empty; token expired; stage not redeployed |
| 401 from the Lambda (`UNAUTHENTICATED`) | `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` don't match the app's pool |
| 403 `FORBIDDEN` | The signed-in user isn't in `event_members` for that event |
| Task timed out after 20 s | VPC/subnets/security group differ from `eventwise-events`; DB secret or DynamoDB permission missing |
| Guest page 500, log says `TIMELINE_SHARE_SECRET …` | Secret missing or shorter than 32 bytes |
| Share link 500, log says `GUEST_APP_ORIGIN …` | Must be `https://host` or `http://localhost:port`, nothing after the host |
| Turning on emails: "Your sign-in has expired" | Sign out and in again; if it persists, Cognito rotated keys — rerun `scripts/refresh-cognito-jwks.ps1`, rebuild and redeploy |
| Toast "update emails couldn't be sent"; log names `TIMELINE_EMAIL_QUEUE_URL` | Variable missing on that function |
| Same toast, no variable named | `sqs:SendMessage` missing, or the queue URL has the wrong account/region |
| Messages pile up in the DLQ; sender log says `MessageRejected` | Recipient or sender not verified in SES (sandbox) |
| Sender log: `AccessDeniedException` | SES policy resource; in the sandbox use `identity/*` |
| Reminders never arrive | Schedule enabled? Reminders log shows `due:0` → check `reminderStatus=PENDING` and `reminderAt` on the item; the item must have been saved with the reminder still in the future |
| Browser CORS error on PUT/PATCH | `TIMELINE_CORS_ORIGIN` must be the exact origin; OPTIONS method missing on that resource; Gateway 4XX/5XX responses lack CORS headers (shared setting, ask Wynn) |

## 13. After the demo

- **Disable** the schedule (it's the only part that runs on its own).
- Leave the table, queues and functions until grading is finished; on-demand DynamoDB and idle Lambdas cost nothing meaningful.
- Purge test messages from the DLQ.

## 14. Rollback

- Code: **Lambda → Versions**, or re-upload the previous ZIP. All three functions share one ZIP, so roll back together.
- Routes: remove the timeline resources and redeploy `prod`; nothing else in the API depends on them.
- Data: the timeline table can be deleted without affecting MySQL or the guest table. Deleting it removes every activity and subscription.
