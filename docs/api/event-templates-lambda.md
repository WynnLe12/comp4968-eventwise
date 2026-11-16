# Event Templates Lambda deployment

This is a separate business Lambda under `event-service`, not `eventwise-db-migrate`.
Local `server.ts` remains available. Both adapters use `services/templates.ts` for
routing, ID validation and response contracts, and the same repository/pool.

## Build a deployment ZIP

Run from `backend/` with Node/npm and zip available:

```sh
npm ci
npm run typecheck
npm run package:templates
```

The packaging command replaces `/tmp/eventwise-event-templates.zip` with a fresh
archive, including production dependencies and the official AWS RDS CA trust bundle.
Upload it to `eventwise-event-templates`. Its root contains `event-service/`,
`shared/`, `certs/`, `node_modules/` and `package.json`. No `.env` files are included.
The archive includes other event-service files; its configured entry point only
handles Templates.

Select a supported Node.js runtime compatible with the project's Node >=22.12
requirement and configure the handler as:

```text
event-service/lambda/templates.handler
```

## Private RDS access

Configure VPC/subnets/security groups so the function can reach the private RDS
endpoint; allow the database port from the function's security group. The migration
function's access does not grant this function access. Attach an execution role
with logging and the permissions required for Lambda VPC networking.

For AWS set `DB_HOST`, `DB_NAME`, `DB_SECRET_ARN`, and **`DB_PORT=3306`**
(or the actual RDS port). `DB_SECRET_ARN` selects Secrets Manager credentials with
JSON string fields `username` and `password`; these override DB_USER/DB_PASSWORD.
The secret may also be binary UTF-8 JSON. Host/database remain environment settings.
Without DB_SECRET_ARN, local DB_USER/DB_PASSWORD and the local 3307 default remain.

Grant the function role `secretsmanager:GetSecretValue` scoped to the secret ARN.
For a customer-managed KMS key also grant `kms:Decrypt` for that key as required.
A private-VPC function needs network access to Secrets Manager, via a Secrets
Manager interface VPC endpoint (with private DNS and HTTPS/443 access) or NAT.
Database reachability alone does not provide access to Secrets Manager.

Secret retrieval and pool creation are lazy, deduplicated across concurrent calls,
and cached for the warm execution environment. Failed initialization can retry.
After rotating credentials, recycle the execution environments to refresh the
cached pool; automatic periodic rotation refresh is not implemented.

Secret mode enables verified TLS using packaged `certs/rds-ca.pem` by default.
`DB_SSL_CA_FILE` can override the certificate path; certificate verification stays
enabled and a missing/invalid CA fails rather than silently disabling TLS. Locally,
TLS remains opt-in through DB_SSL_CA_FILE. The bundled trust store was downloaded
from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem; refresh it
when AWS updates the applicable trust roots. RDS Proxy may require its ACM trust
chain via a custom CA path rather than this direct-RDS bundle.

Set DB_CONNECTION_LIMIT conservatively (e.g. 2) against Lambda concurrency and
optionally DB_CONNECT_TIMEOUT_MS. Keep the pool open across invocations. Choose a
function timeout that allows Secrets Manager retrieval plus database access.

Ensure the schema and `03_template_defaults_seed.sql` have been applied to the
correct RDS database via the team's migration process. The business handler does
not run migrations or seeds. Use a database account permitted to read the two
template tables, rather than the migration account where possible.

## Existing `eventwise` REST API Gateway

Add these resources/methods, using **Lambda proxy integration** (REST payload v1):

| Resource | Methods | Integration |
| --- | --- | --- |
| `/event-templates` | GET, OPTIONS | Templates Lambda |
| `/event-templates/{templateId}` | GET, OPTIONS | Templates Lambda |

Grant API Gateway permission to invoke the function for these routes. Deploy the
REST API to the intended stage after changes. Do not use HTTP API v2 event fields
or response mapping templates for this proxy setup. Gateway forwards `httpMethod`
and `path`; `path` is the resource path without the external stage prefix.

The catalog retains its existing public, read-only policy. This handler does not
verify tokens. If the team changes the policy, configure a Cognito authorizer on
GET and update frontend requests to send the required token. Leave OPTIONS
unauthenticated for preflight.

For cross-origin hosting set `TEMPLATES_CORS_ORIGIN` to one exact frontend origin
(e.g. `https://your-frontend.example`, no trailing slash). The Lambda adds CORS to
success and error responses and handles OPTIONS without querying RDS. Same-origin
hosting can omit this variable. Configure API Gateway-generated errors (such as
DEFAULT_4XX/DEFAULT_5XX) with matching CORS headers as those bypass Lambda. If
Gateway handles OPTIONS itself instead, use the same origin/method/header policy.

## Frontend and smoke checks

Build the organizer frontend with `VITE_API_BASE_URL` set to the invoke URL including
stage, e.g. `https://API_ID.execute-api.REGION.amazonaws.com/dev`. Do not append
`/api` unless that path is actually provided by the deployment. No frontend source
changes are required for the existing public JSON contract.

Check through the deployed Gateway:

- GET list: 200 and `{ "templates": [...] }`.
- GET an existing ID: 200 and `{ "template": {...} }`, with string IDs/percentages.
- GET `0` or an overflowing ID: 400; missing valid ID: 404.
- OPTIONS on both resources: 204 with the configured CORS origin.
- Inspect Templates and Create Event in the browser, including Network/CORS errors.
- Inspect CloudWatch logs if RDS is unavailable; the response must stay generic 500.

Local verification: `npm run typecheck` and `npm test` from `backend/`.
Database integration tests remain opt-in as documented in `event-templates.md`.
No AWS resources are created or updated by the local build/tests.

Reference: [AWS REST Lambda proxy integration](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html).
