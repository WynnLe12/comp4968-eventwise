# Event Templates Lambda deployment

This is a separate business Lambda under `event-service`, not `eventwise-db-migrate`.
Local `server.ts` remains available. Both adapters use `services/templates.ts` for
routing, ID validation and response contracts, and the same repository/pool.

## Build a deployment ZIP

Run from `backend/` with Node/npm and zip available:

```sh
npm ci
npm run typecheck
npm run build
PACKAGE_DIR=$(mktemp -d)
cp package.json package-lock.json "$PACKAGE_DIR/"
cp -R dist/event-service dist/shared "$PACKAGE_DIR/"
npm ci --omit=dev --prefix "$PACKAGE_DIR"
(cd "$PACKAGE_DIR" && zip -qr /tmp/eventwise-event-templates.zip .)
```

Use a fresh output ZIP (remove an older `/tmp/eventwise-event-templates.zip` first
if one exists, because zip updates existing archives). Upload this ZIP to the new
business function, for example `eventwise-event-templates`. The archive root must
contain `event-service/`, `shared/`, `node_modules/` and `package.json`.
Do not include `.env` files or credentials. If using TLS, also package the RDS CA
certificate at the path configured below. The package includes the event-service
code but the Lambda handler only imports the template dependency graph.

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

Configure `DB_HOST`, `DB_PORT` (normally 3306 on RDS; the code's local default is
3307), `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT` (start small, e.g.
2, and size against Lambda concurrency), and optionally `DB_CONNECT_TIMEOUT_MS`.
Supply credentials through the team's approved deployment mechanism; do not put
secrets in source or frontend variables. Automatic Secrets Manager retrieval is
not implemented by this handler.

Set `DB_SSL_CA_FILE` to the packaged RDS CA certificate's absolute path, e.g.
`/var/task/certs/rds-ca.pem`, to enable verified TLS. Reuse the existing lazy pool;
do not close it after invocations. RDS Proxy is optional and can be used as DB_HOST.
Choose function timeout to allow for connection/query time and the API timeout.

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
