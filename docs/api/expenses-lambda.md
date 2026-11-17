# Expenses Lambda deployment guide — Feature 4, commit 9c

## Scope and current status

Commits 9a and 9b add the separate Expenses adapter and local ZIP packaging. This document prepares deployment; it does not deploy AWS resources, invoke a migration, or connect the frontend. Work on `feature4-expense-tracking-lambda`.

The latest team decision is separate service Lambdas. The older architecture image showing a single RDS-connected Event API Lambda needs a team update. Do not replace teammates' Events, Templates, Vendors or Guests integrations.

| Setting | Value |
| --- | --- |
| Proposed function name | `eventwise-expenses` (confirm availability with team) |
| Runtime | Node.js 22.x |
| Deployment ZIP | `backend/build/eventwise-expenses.zip` |
| Handler | `expense-service/lambda/expenses.handler` |
| API contract | Existing REST API, Lambda proxy integration, payload v1 |
| Region used by shared snapshot | `us-west-2` |
| Calendar rules | Expense dates and summary use UTC |

Validated locally: 220 passing tests, 13 opt-in database tests skipped; package smoke checks and separate extracted-ZIP checks passed. These checks do not prove live Cognito, RDS, networking or API Gateway configuration works.

## 1. Record the team's actual resource settings

Before changing AWS, obtain these from the resource owner. Do not substitute resources from a personal account simply because names look similar.

| Item | Value to record privately |
| --- | --- |
| AWS account | Account containing the team's Lambda/API/RDS resources |
| REST API / stage | API ID and intended deployment stage |
| RDS | Endpoint DNS name, database name and port |
| Secret | Existing database credential secret ARN |
| Networking | VPC, private subnets, Lambda security group, RDS security group, Secrets Manager endpoint |
| Cognito | User pool ID, organizer app client ID, existing authorizer ID and accepted scope |
| Organizer | Local origin and eventual deployed origin |
| Application data | Approved event ID, category ID and user membership for testing |

The ZIP's `frontend/organizer/vite.config.ts` already targets `https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod` and strips `/api` from proxied requests. This is a snapshot value, not a verified live endpoint. Confirm it with Wynn before changing it.

An AWS account ID, Cognito pool ID, Cognito app client ID and a user's Cognito `sub` identify different things. A different `sub` for each teammate is normal. SQL `event_members.cognito_sub` must match the actual signed-in user's subject in the intended pool. Do not solve a 403 by disabling membership checks. Cross-account resources require an explicit team design; this guide assumes the team's existing deployment account and networking.

## 2. Review database readiness before invoking migrations

**Do not run `eventwise-db-migrate` merely because this feature is new.** We have not inspected its code. Ask Wynn whether it already ran successfully against the intended RDS database and which SQL version was applied.

The expense repository needs `events`, `event_members`, `budget_categories`, `vendors`, `expenses`, and `expense_payments`, with the columns/relationships from this repository's schema. A signed-in OWNER or CO_PLANNER membership and a category belonging to the test event are required. Vendor association is optional, but a selected vendor must belong to that event.

Have the database owner verify the schema and approved test records. Local Docker success does not establish RDS readiness. Do not run `db:reset`, import the full local schema, or run the local expense seed against shared RDS without reviewing its effects. Fixture IDs such as event 400 are local examples, not guaranteed AWS records.

### How to share the migration for review later

1. Open the AWS Lambda console in `us-west-2`, using the account that owns `eventwise-db-migrate`.
2. Select that function. In **Function overview**, choose **Download → Download function code .zip**. Downloading does not execute the function. Do not choose Test or Deploy.
3. Share the downloaded ZIP after checking for hardcoded credentials or embedded `.env` files. Include SQL files fetched from elsewhere separately, if applicable.
4. Also share the runtime and handler name, environment variable names with sensitive values redacted, and any existing execution-result/log excerpt. Do not invoke it just to obtain fresh logs.
5. Ask Wynn whether the downloaded `$LATEST` code matches the version that was previously run. Downloading `$LATEST` alone cannot prove what executed earlier.

If Download is unavailable, ask the function owner to export it, or copy the handler source and SQL files. We will check whether reruns skip completed work, duplicate rows, or drop/recreate data before deciding whether any invocation is needed.

## 3. Build the artifact locally

From the repository root, on the feature branch:

```bash
nvm use 22
npm --prefix backend ci
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run package:expenses
```

Upload `backend/build/eventwise-expenses.zip`, not `feature4-commit9b.zip`. The latter only distributes source changes. The generated deployment ZIP contains compiled expense/shared modules, production dependencies and `certs/rds-ca.pem`. The handler is at the ZIP root-relative path shown above; do not wrap everything in a `backend/` directory. Build output remains ignored by Git.

## 4. Configure the Expenses function

Reuse an existing team-owned Expenses function if one has already been created. Otherwise create `eventwise-expenses` with Node.js 22.x and the team's selected architecture. In Code, use **Upload from → .zip file**, select the generated artifact, and set the handler under Runtime settings to `expense-service/lambda/expenses.handler`.

Use the team's approved memory/timeout settings. If none exist, 256 MB and 20 seconds are initial demo tuning values, not validated production sizing. Set reserved concurrency according to the shared RDS connection budget: each warm function environment can hold its own pool, and other service Lambdas also consume connections.

### Environment variables

| Variable | Required setting |
| --- | --- |
| `DB_SECRET_ARN` | Existing database secret ARN |
| `DB_HOST` | Actual RDS DNS endpoint; not localhost or just the instance identifier |
| `DB_NAME` | Confirmed database name (team documentation uses `eventwise`) |
| `DB_PORT` | Actual RDS port, normally `3306` |
| `COGNITO_USER_POOL_ID` | Organizer's intended pool, including region prefix |
| `COGNITO_CLIENT_ID` | Organizer's intended app client ID |
| `EXPENSES_CORS_ORIGIN` | Exact direct-browser origin, e.g. `http://localhost:5173`; not an API URL or comma-separated list |
| `DB_CONNECTION_LIMIT` | Consider `2` initially; coordinate with total concurrency and RDS capacity |
| `DB_CONNECT_TIMEOUT_MS` | Optional; defaults to `10000` |
| `DB_SSL_CA_FILE` | Normally omit; packaged default resolves to `/var/task/certs/rds-ca.pem` |

Lambda supplies `AWS_REGION`. Do not copy frontend `VITE_*` variables or entire local `.env` files into Lambda. No `DB_USER` or `DB_PASSWORD` is needed: the secret must contain nonempty `username` and `password` strings. Never disable certificate/hostname verification. Pool credentials are cached in warm environments; rotation refresh is not implemented, so coordinate recycling after credential changes.

### Role and network setup

Use an execution role trusted by `lambda.amazonaws.com` with:

- CloudWatch logging permissions for this function.
- Lambda VPC network-interface permissions (the team's approved `AWSLambdaVPCAccessExecutionRole` equivalent).
- `secretsmanager:GetSecretValue` restricted to the database secret.
- `kms:Decrypt` on the relevant key if a customer-managed KMS key requires it, with compatible key policy.

The Expenses handler needs no DynamoDB or S3 permissions. SQL password authentication does not require `rds-db:connect`. SQL grants are separate: review SELECT access to the six tables above, INSERT/UPDATE/DELETE on expenses, and INSERT on expense_payments against the repository and database version. Use the application account, not the migration administrator.

Attach the function to the team's RDS VPC and approved private subnets. Allow RDS inbound TCP 3306 (or actual DB port) from the Lambda security group; permit matching Lambda egress. For Secrets Manager, use the existing interface endpoint with private DNS and HTTPS 443 connectivity from Lambda, or the team's established NAT path. IAM permission alone does not provide network access. Placing Lambda in a public subnet alone does not provide internet access.

Do not enable a public function URL. The adapter trusts Gateway's authorizer claims, so restrict direct invocation to trusted operators and the intended API Gateway integration.

## 5. Connect only the expense REST resources

Use **Lambda proxy integration** to the Expenses function. Do not configure HTTP API v2 events, mapping templates, or a catch-all that captures other services. Existing `/events` and `/events/{eventId}` resources can be reused as parents without changing their existing methods.

| Resource path | Methods | Expected success |
| --- | --- | --- |
| `/events/{eventId}/expenses` | GET, POST | 200 list, 201 create |
| `/events/{eventId}/expenses/summary` | GET | 200 summary |
| `/events/{eventId}/expenses/{expenseId}` | GET, PATCH, DELETE | 200 detail/update, 204 delete |
| `/events/{eventId}/expenses/{expenseId}/payments` | GET, POST | 200 history, 201 payment |

Create an unauthenticated OPTIONS method for each of these four resources, using proxy integration to the same function; it returns 204 without database access. Ensure the literal `summary` child exists alongside `{expenseId}`. The adapter checks these resource and parameter names when Gateway supplies them.

When allowing API Gateway to invoke Lambda, restrict its resource-policy permission to the intended API, account, stage and expense method/resource ARNs. The AWS console may add this permission; inspect its scope. API Gateway's integration invocation method is POST even for public GET/PATCH/DELETE methods. Snapshot existing integration settings before edits.

### Cognito authentication

For every non-OPTIONS method, select the team's **Cognito user pool authorizer** with `Authorization` as token source. Set a nonempty method authorization scope that the organizer's access token actually contains. For the existing username/password Cognito API sign-in flow, `aws.cognito.signin.user.admin` is the compatibility scope to confirm; if the team uses custom scopes, use an applicable issued scope instead. Do not invent a scope the frontend cannot obtain.

Empty method scopes select ID-token behavior, but this adapter requires access-token claims. Avoid an ID-token audience regex: this adapter checks the access token's `client_id`. Gateway authenticates the token; Lambda requires `sub`, `token_use=access`, the configured pool issuer and app client ID. SQL membership is still checked on each operation.

Test real requests through the deployed API with a real access token. A fabricated Lambda-console authorizer context tests only adapter behavior, not token validation. Never paste tokens into shared chat or commit them.

Deploy/redeploy the REST API to the agreed stage after route/auth changes. A stage deployment can publish other pending API edits too, so coordinate timing with teammates. Preserve existing integrations. Gateway-generated authentication errors need the team's existing GatewayResponse CORS settings for direct cross-origin browser use; changing shared GatewayResponses affects other services.

## 6. Validate the deployed backend before wiring the UI

Use the approved event/category and test user. Start with GET list and GET summary, then exercise writes only on disposable test expenses.

| Check | Expected result |
| --- | --- |
| OPTIONS without a token | 204; configured CORS headers |
| Missing/expired token through Gateway | Denied by Gateway; response format may differ from Lambda |
| Valid access token plus member event | GET list/summary 200 |
| Valid user without event membership | 403 |
| Expense ID belonging to another event | 404 |
| Create with valid category and string money | 201 and Location header |
| PATCH description | 200 |
| Payment within outstanding balance | 201; summary and history update |
| Payment above outstanding balance | 409 |
| Delete expense without payment history | 204 |
| Delete expense with any payment history | 409 |
| Duplicate `limit` query keys or invalid input | 422 |

Example create body (replace category ID with the approved one):

```json
{"categoryId":"REPLACE_CATEGORY_ID","vendorId":null,"description":"Expense deployment check","committedAmount":"10.00","dueDate":null}
```

Record a payment using a real `YYYY-MM-DD` date no later than today in UTC, e.g. `{"amount":"1.00","paidAt":"REPLACE_DATE"}`. Money and IDs remain strings. Use separate disposable expenses for deletion and payment tests: payment history blocks deletion. Agree on cleanup with the database owner. Do not blindly retry payment POST after a timeout; persistent idempotency keys are not implemented, so check history first.

Inspect CloudWatch for initialization/runtime failures and verify persistence by reading the created expense again. Do not run the local database verification scripts against shared RDS without reviewing their writes and cleanup.

## 7. Connect the local frontend in the next work item

The current expense UI uses `mockExpenseStore` and `CURRENT_EVENT_ID`. Changing the Vite proxy alone cannot connect it to Lambda. Replace mock calls with API requests, use the actual selected event/category/vendor IDs, send the Cognito access token, and preserve backend validation/error handling. Coordinate changes to `vendorExpenseContract.ts` with the vendor owner because it also uses the mock expense store.

With the existing dev proxy, frontend `/api/events/...` requests are forwarded to the API stage as `/events/...`; the browser sees a same-origin request. Direct requests to the API URL require CORS. Vite's development proxy does not exist in an Amplify production build; configure the deployed frontend API base separately. Do not change Cognito pool/client settings until the team confirms the intended IDs.

## Troubleshooting and rollback

| Symptom | Check first |
| --- | --- |
| Handler/module not found or 502 | Correct deployment ZIP, root layout, runtime and handler path |
| Gateway 401/403 | Token expiry/type, issued scopes, method authorizer, deployed stage |
| Lambda 401 | Authorizer claims, configured issuer/client ID; do not bypass authentication |
| JSON 403 with event-access message | Actual user's `sub` and OWNER/CO_PLANNER membership |
| 503 database configuration | Missing DB_SECRET_ARN, DB_HOST or DB_NAME |
| Timeout/500 accessing DB | VPC/security groups, secret endpoint/IAM, certificate, SQL grants/schema |
| Browser CORS error | Exact origin, OPTIONS, Gateway-generated error CORS |
| UI still shows mock data | Expense frontend is not yet using API calls |

Retain the prior function version/configuration and expense integration settings before changes. Roll back only this function and its expense methods, then redeploy the agreed API stage as needed. Code rollback does not undo data writes. Do not roll back by dropping tables or rerunning the migration.

## References

- [Lambda ZIP upload and code download](https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-zip.html)
- [REST proxy event and response format](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html)
- [Cognito authorizers and method scopes](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html)
- [Cognito access-token scopes](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html)
- [Lambda VPC configuration](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
- [Secrets Manager VPC endpoints](https://docs.aws.amazon.com/secretsmanager/latest/userguide/vpc-endpoint-overview.html)
