# Payment & Budget Alerts Deployment Guide — Feature 9

Step-by-step AWS Console guide and implementation reference for the daily **Payment & Budget Alerts** feature using **Amazon EventBridge Scheduler**, **AWS Lambda**, **Amazon SNS**, **Amazon Cognito**, and **Amazon SES**.

Work in **US West (Oregon) `us-west-2`** throughout.

---

## 1. Architecture Overview

```text
EventBridge Scheduler (daily 8:00 AM America/Vancouver)
        │
        ▼
eventwise-alerts (VPC Lambda: notification-service/handlers/alerts.handler)
  ├── Queries RDS MySQL (via Secrets Manager + TLS) for:
  │     • Unpaid expenses due within 7 days (today .. today + 7, subtracting refunds)
  │     • Categories where committed spending > planned_amount
  ├── Deduplicates against alert_notifications (MySQL)
  └── Publishes per-event alert to SNS (via VPC Interface Endpoint)
        with MessageAttributes: ownerSub, eventId, alertTypes
        │
        ▼
Amazon SNS Topic (eventwise-payment-budget-alerts)
        │
        ▼
eventwise-alerts-email-sender (Non-VPC Lambda: notification-service/handlers/emailSender.handler)
  ├── Looks up the event owner's email in Cognito (ListUsers by ownerSub)
  └── Sends the alert directly to that owner via Amazon SES
```

### Deployed Resources

| Resource | Name | Purpose |
| --- | --- | --- |
| MySQL Migration | `007_alert_notifications.sql` | Creates `alert_notifications` table in RDS `eventwise` for deduplication |
| VPC Endpoint | `eventwise-sns-endpoint` | Allows the VPC Lambda to call SNS (`com.amazonaws.us-west-2.sns`) without a NAT Gateway |
| SNS Topic | `eventwise-payment-budget-alerts` | Decouples alert detection (VPC) from owner email delivery (non-VPC) |
| Lambda (Checker) | `eventwise-alerts` | Handler `notification-service/handlers/alerts.handler` inside the RDS VPC |
| Lambda (Email Sender) | `eventwise-alerts-email-sender` | Handler `notification-service/handlers/emailSender.handler` **outside** the VPC |
| EventBridge Schedule | `eventwise-daily-alerts` | Runs every morning (`cron(0 8 * * ? *)`, `America/Vancouver`) |

---

## 2. Implementation Details

* **Source files** (`backend/notification-service/`):
  * `types.ts` — domain types for due payments, budget overruns, deduplication records, and run summaries.
  * `repositories/mysql-alerts.ts` — parameterized SQL queries for unpaid due payments (`due_date BETWEEN startDate AND endDate` with `committed_amount > net_paid`), category overruns (`SUM(committed_amount) > planned_amount`), and `alert_notifications` reads/inserts (`INSERT IGNORE`).
  * `services/alertService.ts` — exact `bigint` cent math, `[0, 7]` day boundary validation, per-event digest email formatting, deduplication, and per-event error isolation (failed publishes are never recorded as sent so they retry on the next run).
  * `services/snsPublisher.ts` — publishes to SNS with 100-char subject truncation and `ownerSub`, `eventId`, and `alertTypes` message attributes.
  * `handlers/alerts.ts` — EventBridge Lambda entry point (`notification-service/handlers/alerts.handler`).
  * `handlers/emailSender.ts` — SNS-triggered non-VPC Lambda (`notification-service/handlers/emailSender.handler`) that resolves `ownerSub` to an email address via Cognito `ListUsers` (with per-invocation caching and `sub` validation) and sends the email via SESv2 `SendEmail`.
* **Deduplication rules** (`alert_notifications`):
  * `PAYMENT_DUE`: `dedupe_key = due:<YYYY-MM-DD>`. Prevents duplicate alerts across repeated daily runs; re-notifies only if the expense due date changes to a new date entering the 7-day window.
  * `BUDGET_OVERRUN`: `dedupe_key = overrun:<planned_amount>:<committed_total>`. Prevents duplicate alerts while totals are unchanged; re-notifies if spending or planned budget changes while still over budget.
* **Tests**: `backend/tests/alerts.test.ts` (10 unit tests covering day `-1`/`0`/`7`/`8` boundaries, 1-cent overruns, false-alert prevention, deduplication, SNS failure handling, Cognito lookup, and SES delivery).

---

## 3. Build the Deployment Package

Both Lambdas ship in the same ZIP archive (`backend/build/eventwise-alerts.zip`):

```bash
cd backend
npm ci
npm run typecheck
npm test
npm run package:alerts
```

`package:alerts` smoke-loads both `notification-service/handlers/alerts.js` and `notification-service/handlers/emailSender.js` in isolation and verifies the bundled `certs/rds-ca.pem`.

---

## 4. Apply the Database Migration

Run `database/mysql/migrations/007_alert_notifications.sql` against the `eventwise` database (local Docker MySQL or Amazon RDS `eventwise-db`).

---

## 5. Create the SNS VPC Interface Endpoint

Because EventWise's VPC (`vpc-0a29df84c9e10f13e`) has **no NAT Gateway**, the checker Lambda inside the VPC needs an interface endpoint to reach SNS (just like `eventwise-secrets-endpoint` and `eventwise-sqs-endpoint`):

1. Open **VPC → Endpoints → Create endpoint**.
2. Name tag: `eventwise-sns-endpoint`.
3. Service category: **AWS services** → search **`com.amazonaws.us-west-2.sns`** (Type: Interface).
4. VPC: `vpc-0a29df84c9e10f13e` | Subnets: same two subnets used by `eventwise-events` | **Enable DNS name: Checked**.
5. Security group: reuse `eventwise-sqs-endpoint-sg` (or any SG allowing inbound **TCP 443** from `eventwise-lambda-sg`).
6. Create and wait until status is **Available**.

---

## 6. Create the SNS Topic

1. Open **Amazon SNS → Topics → Create topic**.
2. Type: **Standard** | Name: `eventwise-payment-budget-alerts`.
3. Click **Create topic** and copy the **Topic ARN**.

---

## 7. Create Lambda #1: `eventwise-alerts` (VPC Checker)

1. **Lambda → Create function → Author from scratch** → Name: `eventwise-alerts` | Runtime: **Node.js 22.x** (`x86_64`).
2. **IAM Role** (**Configuration → Permissions → Role name** — do this **before** attaching the VPC):
   * Attach AWS managed policy: **`AWSLambdaVPCAccessExecutionRole`**.
   * Add inline policy (`EventWiseAlertsPolicy`):
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Sid": "ReadDatabaseSecret",
           "Effect": "Allow",
           "Action": "secretsmanager:GetSecretValue",
           "Resource": "<DB_SECRET_ARN>"
         },
         {
           "Sid": "PublishAlertsToSns",
           "Effect": "Allow",
           "Action": "sns:Publish",
           "Resource": "<ALERTS_SNS_TOPIC_ARN>"
         }
       ]
     }
     ```
3. **Code → Upload from → .zip file** → upload `backend/build/eventwise-alerts.zip`.
4. **Runtime settings → Edit → Handler**: `notification-service/handlers/alerts.handler`.
5. **General configuration**: Memory `256 MB`, Timeout `30 s`.
6. **VPC**: Attach to `vpc-0a29df84c9e10f13e`, the two `eventwise-events` subnets, and security group **`eventwise-lambda-sg`**.
7. **Environment variables** (copy DB settings from `eventwise-events`):
   * `DB_SECRET_ARN`, `DB_HOST`, `DB_PORT` (`3306`), `DB_NAME` (`eventwise`), `DB_CONNECTION_LIMIT` (`2`)
   * `ALERTS_SNS_TOPIC_ARN`: `<Topic ARN from Step 6>`

---

## 8. Create Lambda #2: `eventwise-alerts-email-sender` (Non-VPC Sender)

1. **Lambda → Create function → Author from scratch** → Name: `eventwise-alerts-email-sender` | Runtime: **Node.js 22.x** (`x86_64`).
2. **VPC**: Leave **None** (must stay outside the VPC to reach Cognito and SES).
3. **Code → Upload from → .zip file** → upload the same `backend/build/eventwise-alerts.zip`.
4. **Runtime settings → Edit → Handler**: `notification-service/handlers/emailSender.handler`.
5. **General configuration**: Memory `256 MB`, Timeout `30 s`.
6. **Environment variables**:
   * `COGNITO_USER_POOL_ID`: `us-west-2_bV89z9COo`
   * `SES_FROM_ADDRESS`: `<verified SES sender email>` (same as `eventwise-timeline-email-sender`)
7. **IAM Role** (**Configuration → Permissions → Role name** → **Create inline policy → JSON**):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "LookupOwnerEmailInCognito",
         "Effect": "Allow",
         "Action": "cognito-idp:ListUsers",
         "Resource": "arn:aws:cognito-idp:us-west-2:<ACCOUNT_ID>:userpool/us-west-2_bV89z9COo"
       },
       {
         "Sid": "SendAlertEmailWithSes",
         "Effect": "Allow",
         "Action": "ses:SendEmail",
         "Resource": "arn:aws:ses:us-west-2:<ACCOUNT_ID>:identity/*"
       }
     ]
   }
   ```
8. **SNS Trigger**: Click **Add trigger → SNS** → select **`eventwise-payment-budget-alerts`** → **Add**.
   *(Make sure each demo owner email is verified in **Amazon SES → Identities** while in the SES sandbox.)*

---

## 9. Schedule Daily Execution with EventBridge Scheduler

1. Open **Amazon EventBridge → Scheduler → Schedules → Create schedule**.
2. Name: `eventwise-daily-alerts`.
3. **Recurring schedule → Cron-based**: `0 8 * * ? *` | Timezone: **America/Vancouver** | Flexible time window: **Off**.
4. Target: **AWS Lambda → Invoke** → select **`eventwise-alerts`** | Payload: `{}`.
5. Permissions: **Create new role for this schedule** → **Create schedule**.

---

## 10. Verify End-to-End

1. In Lambda **`eventwise-alerts`** → **Test**, invoke with `{}` (or `{"runDate": "2026-11-27"}`):
   * Returns a JSON summary (`notificationsSent`, `alertsRecorded`, `failedEvents: 0`).
   * Triggers **`eventwise-alerts-email-sender`** via SNS; check its CloudWatch Logs to confirm each event's owner email was resolved from Cognito and sent via SES.
2. Click **Test** a second time immediately:
   * Verify `notificationsSent: 0` and `alertsSkippedAsDuplicate > 0` (no duplicate emails sent).
