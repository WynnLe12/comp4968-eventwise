# Payment & Budget Alerts Lambda Deployment Guide — Feature 9

Step-by-step AWS Console guide for deploying the daily **Payment & Budget Alerts** feature using **Amazon EventBridge Scheduler**, **AWS Lambda**, and **Amazon SNS**.

Work in **US West (Oregon) `us-west-2`** throughout.

---

## 1. Architecture Overview

| Resource | Name | Purpose |
| --- | --- | --- |
| MySQL Migration | `007_alert_notifications.sql` | Creates `alert_notifications` table in RDS `eventwise` for deduplication |
| VPC Endpoint | `eventwise-sns-endpoint` | Allows the VPC Lambda to call SNS (`com.amazonaws.us-west-2.sns`) without a NAT Gateway |
| SNS Topic | `eventwise-payment-budget-alerts` | Delivers owner email alerts (supports optional per-owner filter policies via `ownerSub`) |
| Lambda (Checker) | `eventwise-alerts` | Handler `notification-service/handlers/alerts.handler` inside the RDS VPC |
| Lambda (Email Sender) | `eventwise-alerts-email-sender` | Handler `notification-service/handlers/emailSender.handler` **outside** the VPC (resolves owner email from Cognito and sends via SES) |
| EventBridge Schedule | `eventwise-daily-alerts` | Runs every morning (`cron(0 8 * * ? *)` America/Vancouver) |

---

## 2. Build the Deployment Package

```bash
cd backend
npm ci
npm run typecheck
npm test
npm run package:alerts
```

This outputs **`backend/build/eventwise-alerts.zip`**.

---

## 3. Apply the Database Migration

Run `database/mysql/migrations/007_alert_notifications.sql` against the `eventwise` database (local Docker MySQL or Amazon RDS `eventwise-db`).

---

## 4. Create the SNS VPC Interface Endpoint (Required for VPC Lambda)

Because EventWise's VPC (`vpc-0a29df84c9e10f13e`) has **no NAT Gateway**, the Lambda inside the VPC needs an interface endpoint to reach SNS (just like `eventwise-secrets-endpoint` and `eventwise-sqs-endpoint`):

1. Open **VPC → Endpoints → Create endpoint**.
2. Name tag: `eventwise-sns-endpoint`.
3. Service category: **AWS services**.
4. Services: Search **`sns`** and select **`com.amazonaws.us-west-2.sns`** (Type: Interface).
5. VPC: Select `vpc-0a29df84c9e10f13e`.
6. Subnets: Select the same two subnets used by `eventwise-events` Lambda.
7. Enable DNS name: **Checked** (Private DNS enabled).
8. Security groups: Select a security group that allows **Inbound HTTPS (TCP 443)** from **`eventwise-lambda-sg`** (you can reuse `eventwise-sqs-endpoint-sg` or create `eventwise-sns-endpoint-sg`).
9. Click **Create endpoint** and wait until status is **Available**.

---

## 5. Create the SNS Topic & Email Subscription

1. Open **Amazon SNS → Topics → Create topic**.
2. Type: **Standard**.
3. Name: `eventwise-payment-budget-alerts`.
4. Display name: `EventWise` (optional).
5. Click **Create topic** and copy the **Topic ARN** (e.g. `arn:aws:sns:us-west-2:<ACCOUNT_ID>:eventwise-payment-budget-alerts`).
6. Under **Subscriptions → Create subscription**:
   - Protocol: **Email**
   - Endpoint: Your owner email address
   - *(Optional, for multi-owner filtering)* Under **Subscription filter policy**, enable and set **Message attributes** scope:
     ```json
     {
       "ownerSub": ["<COGNITO_USER_SUB>"]
     }
     ```
     *(Leave filter policy off during single-owner demo to receive all event alerts.)*
7. Open your email inbox and click **Confirm subscription**.

---

## 6. Create the Lambda Function (`eventwise-alerts`)

1. Open **AWS Lambda → Create function → Author from scratch**.
2. Function name: `eventwise-alerts`.
3. Runtime: **Node.js 22.x** (`x86_64`).
4. Permissions: **Create a new role with basic Lambda permissions**.
5. Upload code: **Code → Upload from → .zip file** → upload `backend/build/eventwise-alerts.zip`.
6. Runtime settings: **Edit → Handler** → `notification-service/handlers/alerts.handler`.
7. General configuration: Memory **256 MB**, Timeout **30 seconds**.
8. **VPC**: Attach to `vpc-0a29df84c9e10f13e`, same two subnets as `eventwise-events`, security group **`eventwise-lambda-sg`**.
9. **Environment variables** (copy DB settings from `eventwise-events`):
   - `DB_SECRET_ARN`: `<same as eventwise-events>`
   - `DB_HOST`: `<same as eventwise-events>`
   - `DB_PORT`: `3306`
   - `DB_NAME`: `eventwise`
   - `DB_CONNECTION_LIMIT`: `2`
   - `ALERTS_SNS_TOPIC_ARN`: `<Topic ARN from Step 5>`
10. **IAM Role permissions** (**Configuration → Permissions → click Role name**):
    - Attach AWS managed policy: **`AWSLambdaVPCAccessExecutionRole`**.
    - Add inline policy (`EventWiseAlertsPolicy`):
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

---

## 7. Schedule Daily Execution with EventBridge Scheduler

1. Open **Amazon EventBridge → Scheduler → Schedules → Create schedule**.
2. Schedule name: `eventwise-daily-alerts`.
3. Occurrence: **Recurring schedule**.
4. Schedule type: **Cron-based schedule**.
   - Cron expression: `0 8 * * ? *`
   - Timezone: **America/Vancouver** (runs every morning at 8:00 AM local time).
5. Flexible time window: **Off** (or 5 minutes).
6. Target: **AWS Lambda → Invoke** → select **`eventwise-alerts`**.
7. Payload: `{}`.
8. Permissions: **Create new role for this schedule**.
9. Click **Create schedule**.

---

## 8. Verify in AWS Console

1. Open Lambda `eventwise-alerts` → **Test** tab.
2. Invoke with `{}` (or `{"runDate": "2026-11-26"}` to test a specific date).
3. Check the returned JSON summary:
   ```json
   {
     "runDate": "2026-11-26",
     "windowDays": 7,
     "eventsEvaluated": 1,
     "paymentsDueFound": 1,
     "budgetOverrunsFound": 1,
     "alertsSkippedAsDuplicate": 0,
     "notificationsSent": 1,
     "alertsRecorded": 2,
     "failedEvents": 0
   }
   ```
4. Confirm you received the email in your inbox.
5. Click **Test** a second time immediately: verify `notificationsSent: 0` and `alertsSkippedAsDuplicate: 2` (no duplicate email!).
