# RSVP Lambdas deployment guide — Feature 8

Step-by-step console checklist for deploying invitations and RSVP: one DynamoDB table, one SQS queue (plus DLQ), three Lambda functions from one ZIP, one Step Functions state machine and the API Gateway routes. Emails go through the SES identities the timeline already uses. API contract: [rsvp.md](rsvp.md). Table design: [database/dynamodb/rsvp.md](../../database/dynamodb/rsvp.md).

Work in **US West (Oregon) us-west-2** throughout.

## 1. What gets deployed

| Resource | Name | Notes |
| --- | --- | --- |
| DynamoDB table | `EventWise_Rsvp` | Partition key `eventId`. `EventWise_Guests` already exists and is reused |
| SQS queue | `eventwise-rsvp-emails` | + DLQ `eventwise-rsvp-emails-dlq` |
| Lambda (API) | `eventwise-rsvp` | Handler `rsvp-service/lambda/rsvp.handler` |
| Lambda (deadline steps) | `eventwise-rsvp-deadline` | Handler `rsvp-service/lambda/deadline.handler`. Invoked by Step Functions only |
| Lambda (email sender) | `eventwise-rsvp-email-sender` | Handler `rsvp-service/lambda/emailSender.handler`. SQS trigger |
| Step Functions | `eventwise-rsvp-deadline` (Standard) | Definition: `infrastructure/stepfunctions/rsvp-deadline.asl.json` |
| API Gateway | REST API `hd63bpgxm8`, stage `prod` | 4 new resources: `/events/{eventId}/rsvp…` and `/rsvp/{token}` |
| SES identities | existing sender + demo guests | Account is in the SES sandbox |

All three functions use the same `backend/build/eventwise-rsvp.zip`, and **none of them is in a VPC**. They need Step Functions, which the default VPC can't reach (no NAT gateway, no Step Functions endpoint), and they don't use MySQL: membership is checked by calling the Event API with the organizer's own token, like the guest Lambda does.

Create things in this order; later steps need ARNs from earlier ones: secret → table → queues → deadline Lambda → state machine → API Lambda → sender Lambda → API Gateway.

## 2. Before you start

1. Build the ZIP on the feature branch:

   ```bash
   cd backend
   npm ci
   npm run typecheck && npm test
   npm run package:rsvp
   ```

   It must end with `RSVP package smoke checks passed`. Upload `backend/build/eventwise-rsvp.zip` (about 8 MB). The handlers are at the ZIP root; don't re-zip it inside a folder.

2. Generate the RSVP link secret (keep it out of Git, Discord and screenshots):

   ```bash
   openssl rand -base64 48
   ```

   The same value goes into `RSVP_LINK_SECRET` on **both** `eventwise-rsvp` and `eventwise-rsvp-deadline`. Use a different value from `TIMELINE_SHARE_SECRET`. Changing it later breaks every RSVP link already emailed.

3. Note down:
   - `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` from the `eventwise-events` function (**Configuration → Environment variables**).
   - The guest table's name from the existing guest Lambda (its `DDB_TABLE_NAME`). This guide assumes `EventWise_Guests`.
   - The Event API invoke URL: `https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod`.
   - Your AWS account ID (top-right menu), shown below as `<ACCOUNT_ID>`.

4. Decide the app origin. Use `http://localhost:5173` while testing locally, and the Amplify URL once deployed (section 12).

## 3. DynamoDB table

**DynamoDB → Tables → Create table**

1. Table name `EventWise_Rsvp`. Partition key `eventId` (String). No sort key.
2. **Table settings → Customize settings → Capacity mode: On-demand.** No secondary indexes.
3. Create, wait for **Active**.

`EventWise_Guests` needs no change: the RSVP attributes are added to items as guests are invited and answer.

## 4. SQS queues

**SQS → Create queue**, type **Standard**, twice:

| Setting | `eventwise-rsvp-emails-dlq` (create first) | `eventwise-rsvp-emails` |
| --- | --- | --- |
| Visibility timeout | 30 s | **180 s** (6 × the sender's 30 s timeout) |
| Message retention | 14 days | 4 days |
| Encryption | SSE-SQS (default) | SSE-SQS (default) |
| Dead-letter queue | — | Enabled → `eventwise-rsvp-emails-dlq`, **Maximum receives 3** |

Copy the main queue's **URL** (for `RSVP_EMAIL_QUEUE_URL`) and **ARN**.

## 5. SES (sandbox)

The timeline already set up SES in us-west-2. Reuse its verified sender as `SES_FROM_ADDRESS`.

While the account is in the sandbox, **every guest email you send to must be a verified identity** (**Amazon SES → Identities → Create identity → Email address**, then click the link in that inbox). Otherwise SES rejects the message with `MessageRejected` and it ends up in the DLQ. For a demo, give your test guests addresses you control. For guests you can't verify, use **Copy RSVP link** in the guest's edit form instead.

## 6. Lambda `eventwise-rsvp-deadline` (first, so the state machine can call it)

**Lambda → Create function → Author from scratch**

| Setting | Value |
| --- | --- |
| Name | `eventwise-rsvp-deadline` |
| Runtime / arch | Node.js 22.x / x86_64 |
| Execution role | Create a new role with basic Lambda permissions |

Then:

1. **Code → Upload from → .zip file** → `eventwise-rsvp.zip`.
2. **Runtime settings → Edit → Handler** → `rsvp-service/lambda/deadline.handler`.
3. **Configuration → General configuration**: memory 256 MB, timeout **60 s**.
4. **Configuration → VPC**: none.
5. **Configuration → Environment variables**:

   | Key | Value |
   | --- | --- |
   | `RSVP_TABLE_NAME` | `EventWise_Rsvp` |
   | `GUESTS_TABLE_NAME` | `EventWise_Guests` |
   | `RSVP_LINK_SECRET` | From section 2 |
   | `GUEST_APP_ORIGIN` | `http://localhost:5173` for now |
   | `RSVP_EMAIL_QUEUE_URL` | Queue URL from section 4 |

6. **Configuration → Permissions → role name → Add permissions → Create inline policy → JSON**, name it `eventwise-rsvp-deadline-access`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "RsvpSettings", "Effect": "Allow",
         "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
         "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Rsvp" },
       { "Sid": "Guests", "Effect": "Allow",
         "Action": ["dynamodb:Query", "dynamodb:UpdateItem"],
         "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Guests" },
       { "Sid": "QueueEmails", "Effect": "Allow", "Action": "sqs:SendMessage",
         "Resource": "arn:aws:sqs:us-west-2:<ACCOUNT_ID>:eventwise-rsvp-emails" }
     ]
   }
   ```

7. Copy the function **ARN** (top right of the function page).

## 7. Step Functions state machine

1. Open `infrastructure/stepfunctions/rsvp-deadline.asl.json` and replace both `<DEADLINE_FUNCTION_ARN>` with the ARN from section 6.
2. **Step Functions → State machines → Create state machine → Create from blank**, switch to the **Code** view, and paste the JSON.
3. **Config**: name `eventwise-rsvp-deadline`, type **Standard** (Express can't wait days), permissions **Create new role**. The console reads the definition and gives the role `lambda:InvokeFunction` on that function. If your console doesn't, add this inline policy to the role:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "lambda:InvokeFunction",
         "Resource": [
           "arn:aws:lambda:us-west-2:<ACCOUNT_ID>:function:eventwise-rsvp-deadline",
           "arn:aws:lambda:us-west-2:<ACCOUNT_ID>:function:eventwise-rsvp-deadline:*"
         ] }
     ]
   }
   ```

4. **Create**, then copy the state machine **ARN**.

What it does: wait until `reminderAt` → invoke the deadline Lambda with `REMIND` → wait until `deadline` → invoke with `CLOSE`. Each run is cheap: Standard workflows bill per state transition (about six per run), not for time spent waiting.

## 8. Lambda `eventwise-rsvp` (the API)

Create it the same way as section 6, with:

| Setting | Value |
| --- | --- |
| Name | `eventwise-rsvp` |
| Handler | `rsvp-service/lambda/rsvp.handler` |
| Memory / timeout | 256 MB / **30 s** (sending invitations to a few hundred guests) |
| VPC | none |

Environment variables:

| Key | Value |
| --- | --- |
| `RSVP_TABLE_NAME` | `EventWise_Rsvp` |
| `GUESTS_TABLE_NAME` | `EventWise_Guests` |
| `RSVP_LINK_SECRET` | **Same value** as on `eventwise-rsvp-deadline` |
| `GUEST_APP_ORIGIN` | `http://localhost:5173` for now |
| `RSVP_EMAIL_QUEUE_URL` | Queue URL from section 4 |
| `RSVP_STATE_MACHINE_ARN` | ARN from section 7 |
| `EVENT_API_URL` | `https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod` |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | Same as `eventwise-events` |
| `RSVP_CORS_ORIGIN` | Exact browser origin, e.g. `http://localhost:5173` (one origin only) |

Don't set `AWS_REGION` (Lambda provides it) or `DYNAMODB_ENDPOINT` (that would point at DynamoDB Local).

Inline policy `eventwise-rsvp-access`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "RsvpSettings", "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
      "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Rsvp" },
    { "Sid": "Guests", "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:us-west-2:<ACCOUNT_ID>:table/EventWise_Guests" },
    { "Sid": "QueueEmails", "Effect": "Allow", "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:us-west-2:<ACCOUNT_ID>:eventwise-rsvp-emails" },
    { "Sid": "StartWorkflow", "Effect": "Allow", "Action": "states:StartExecution",
      "Resource": "arn:aws:states:us-west-2:<ACCOUNT_ID>:stateMachine:eventwise-rsvp-deadline" },
    { "Sid": "StopOldWorkflow", "Effect": "Allow", "Action": "states:StopExecution",
      "Resource": "arn:aws:states:us-west-2:<ACCOUNT_ID>:execution:eventwise-rsvp-deadline:*" }
  ]
}
```

`ConditionCheckItem` is needed because a guest's answer is saved in a transaction that checks the RSVPs are still open.

## 9. Lambda `eventwise-rsvp-email-sender`

Same ZIP, with:

| Setting | Value |
| --- | --- |
| Name | `eventwise-rsvp-email-sender` |
| Handler | `rsvp-service/lambda/emailSender.handler` |
| Memory / timeout | 256 MB / 30 s |
| VPC | none |
| Environment | `SES_FROM_ADDRESS` = the verified sender, e.g. `EventWise <team@example.com>` |

Permissions: attach the managed policy **`AWSLambdaSQSQueueExecutionRole`**, plus this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "SendRsvpEmail", "Effect": "Allow", "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:us-west-2:<ACCOUNT_ID>:identity/*" }
  ]
}
```

`identity/*` is deliberate for the sandbox, where SES also checks permission on each verified *recipient*. Narrow it to the sender identity after production access.

**Add trigger → SQS** → `eventwise-rsvp-emails`:

- Batch size **10**, batch window 0.
- **Report batch item failures: on.** Without it, one bad message makes the whole batch retry and re-send emails that already went out.
- Maximum concurrency **2** (keeps under the sandbox's 1 email/second).

## 10. API Gateway

**API Gateway → APIs → `hd63bpgxm8` → Resources.** Create:

| Resource | Methods | Authorization |
| --- | --- | --- |
| `/events/{eventId}/rsvp` (under the existing `/events/{eventId}`) | GET | `EventWiseCognitoAuthorizer`, scope `aws.cognito.signin.user.admin` |
| `/events/{eventId}/rsvp/invitations` | POST | same |
| `/events/{eventId}/rsvp/links/{guestId}` (create `links`, then `{guestId}` under it) | GET | same |
| `/rsvp/{token}` (new top-level `/rsvp`, then `{token}`) | GET, PUT | **NONE** (the signed link is the credential) |

For **every** method: integration type **Lambda function**, **Lambda proxy integration on**, function `eventwise-rsvp`. Accept the console's permission prompt.

Also add an **OPTIONS** method with **no authorization** on each of the four resources, proxied to the same function. It answers CORS preflights with 204 and never touches AWS.

Notes:
- Use the same method scope as the existing `/events` methods. An **empty** scope list makes the authorizer expect ID tokens, and every organizer call then fails with 401.
- Recommended: **Stages → prod → `/rsvp/{token}` GET and PUT → Override for this method → Throttling**: rate 10, burst 20.
- `/rsvp` must not collide with anything already at the API root. Check the resource tree first.

Then **Deploy API → prod**. A deployment publishes everyone's pending API edits too, so post in Discord first.

## 11. Frontend

No new environment variables: the organizer app already calls this API through `VITE_API_BASE_URL` (the `/api` Vite proxy locally). Run it from `frontend/organizer` with `npm run dev`:

- **Invitations & RSVP** (sidebar): set the start time, deadline, reminder and note, then **Save and send invitations**.
- **Guests → edit a guest → Copy RSVP link**: one guest's private link.
- `/rsvp/<token>`: the public page guests open from their email.

## 12. After Amplify goes live

On `eventwise-rsvp` **and** `eventwise-rsvp-deadline`, set `GUEST_APP_ORIGIN` to the Amplify URL, e.g. `https://main.d1234abcd.amplifyapp.com` (no trailing path). On `eventwise-rsvp`, set `RSVP_CORS_ORIGIN` to the same value. Links in emails already sent still point at the old origin; re-send invitations with **Also re-send to guests who haven't answered** if needed.

Amplify must route `/rsvp/*` to `index.html` (the same SPA rewrite as `/timeline/*` and `/gallery/*`).

## 13. Verify end to end

Use two guests whose emails are verified in SES, one with **Allow a plus-one**.

| # | Check | Expected |
| --- | --- | --- |
| 1 | Open **Invitations & RSVP** as the owner and as a co-planner | "Invitations not sent yet", counts match the Guests page |
| 2 | Call `GET /events/<id>/rsvp` as a user who isn't a member | 403 |
| 3 | Set a deadline ~20 min ahead, reminder **1 day before**, press Send | 422: the reminder would already have passed |
| 4 | Deadline 2 days ahead, reminder 1 day before, a start time and a note → Send | "Sent 2 invitations"; both guests Pending; `EventWise_Rsvp` has the item; **Step Functions** shows one execution in `WaitForReminder` |
| 5 | Check the inboxes | Invitation with date, start time, venue, note, deadline and an **RSVP now** button |
| 6 | Open the link in a private window | Event details and the form, without signing in |
| 7 | Change one character of the token | "This link doesn't work" |
| 8 | Accept with a meal, an allergy and the plus-one; then **Change my response** | Saved; Guests page shows Accepted, the meal, the allergy note and "+ plus-one coming" |
| 9 | Guest without a plus-one: try to send `plusOneAttending: true` with curl | 422 |
| 10 | Send again (nothing ticked) | "No new invitations to send"; the old execution shows **Aborted** and a new one starts |
| 11 | Short test: deadline 6 min ahead, reminder 0 → send; wait | At the deadline the execution reaches `CloseRsvps` and succeeds; the page says RSVPs closed and a PUT returns 409 |
| 12 | Reminder test: run the deadline Lambda's **Test** with `{"action":"REMIND","eventId":"<id>","workflowId":"<workflowId from the table>"}` | Only Pending guests get a reminder; run again → nobody is emailed twice |
| 13 | **CloudWatch → Log groups** for all three functions | Counts only, e.g. `RSVP invitations for event 42: 2 queued, 0 failed`; no addresses or links |
| 14 | SQS DLQ | Empty |

## 14. Troubleshooting

| Symptom | Check first |
| --- | --- |
| Handler not found / 502 | Correct ZIP (not a re-zip), handler path, Node.js 22.x |
| Every organizer call 401 from Gateway | Method scope missing or empty; stage not redeployed |
| 401 from the Lambda (`UNAUTHENTICATED`) | `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` don't match the app's pool |
| 403 `FORBIDDEN` for a member | `EVENT_API_URL` wrong (must be the `prod` stage URL, no trailing `/events`) |
| 502 `UPSTREAM_ERROR` | The Event API is down or `EVENT_API_URL` isn't `https://…` |
| 502 `SCHEDULING_FAILED` | `states:StartExecution` missing, or `RSVP_STATE_MACHINE_ARN` wrong |
| 500 and the log names `RSVP_LINK_SECRET` / `GUEST_APP_ORIGIN` / `RSVP_EMAIL_QUEUE_URL` | That variable is missing or invalid on the function that logged it |
| 500 on a guest's answer, log says `AccessDeniedException` | `dynamodb:ConditionCheckItem` missing on `EventWise_Rsvp` |
| Execution fails at `SendReminders` with `Lambda.AccessDeniedException` | The state machine role can't invoke `eventwise-rsvp-deadline` (section 7) |
| Execution shows `RemindersIncompleteError`, then retries | Some reminders couldn't be queued; check `sqs:SendMessage` on the deadline role |
| Invitations "sent" but no email | Sender log: `MessageRejected` → recipient not verified in SES (sandbox); messages in the DLQ |
| Browser CORS error on PUT from the guest page | `RSVP_CORS_ORIGIN` must be the exact origin; OPTIONS missing on `/rsvp/{token}` |
| RSVP link opens the sign-in page | Old frontend build: `/rsvp/` must be in `isPublicGuestPage` (`routes/navigation.ts`) |

## 15. After the demo

- Running executions are harmless: they wait and then close RSVPs. To stop them, use **Step Functions → executions → Stop**.
- Purge test messages from the DLQ.
- Leave the table, queues and functions until grading is finished; on-demand DynamoDB and idle Lambdas cost nothing meaningful.

## 16. Rollback

- Code: **Lambda → Versions**, or re-upload the previous ZIP. All three functions share one ZIP, so roll back together.
- Routes: remove the four RSVP resources and redeploy `prod`. Nothing else in the API depends on them.
- Data: `EventWise_Rsvp` can be deleted without affecting MySQL. Guests keep their answers in `EventWise_Guests`; the extra attributes are ignored by the guest API.
