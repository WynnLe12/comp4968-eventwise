# Events CRUD Lambda: implementation and deployment review

Target function: **`eventwise-events`**. Handler: **`event-service/lambda/events.handler`**.

This document describes a later deployment to the existing EventWise REST API, RDS instance `eventwise-db` (database `eventwise`), Secrets Manager secret and EventWise VPC. Implementation/build/tests do not create resources, import schema, seed data, or deploy anything. Existing guest and template integrations remain unchanged.

## Routes and implementation

| REST resource | Method | Existing handler reused | Success |
| --- | --- | --- | --- |
| `/events` | GET | listEventsHandler | 200 direct array with requesting role |
| `/events` | POST | createEventHandler | 201 direct event object, no role field |
| `/events/{eventId}` | GET | getEventHandler | 200 direct event object with role |
| `/events/{eventId}` | PATCH | updateEventHandler | 200 direct updated event with role |
| `/events/{eventId}` | DELETE | deleteEventHandler | 204 empty body |

Use **REST API Lambda proxy integration (`AWS_PROXY`, payload v1)** for these exact methods. The integration's invocation method is POST regardless of the public HTTP method. No mapping template or HTTP API v2 adapter is needed. `event.path` is the application path without the external stage prefix; optional resource/path-parameter metadata must agree. Literal `/events/`, unsupported methods, nested budget/guest routes and unknown paths retain 404. No catch-all `ANY /{proxy+}` integration is introduced. [AWS REST proxy contract](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html).

The adapter converts the proxy-v1 body (including base64) to a readable Node request, normalizes case-insensitive headers, gives multiValueHeaders precedence, and captures the existing handlers' writeHead/end output. Body parsers still enforce JSON media type and a decoded 65,536-byte limit. BIGINT identifiers/DECIMAL values remain strings; dates/nullability and snake_case event fields remain unchanged. Handler error messages and 400/401/403/404/409/413/415/500 responses are retained. Identity is resolved before service/body processing. The shared `authenticateEvent` helper preserves local bearer verification when no trusted adapter callback is supplied.

Services/repositories/schema are unchanged. Event create still creates OWNER membership and template categories transactionally. Reads check membership; PATCH and DELETE require OWNER. Identity is never taken from body/query/header fields. Local server.ts still runs separately and uses its existing JWT verification.

## Cognito access-token authorizer configuration

The organizer currently sends `Authorization: Bearer <access token>`. Keep that client behavior.

1. On the **five Events methods only**, select a `COGNITO_USER_POOLS` authorizer for the existing intended pool, with token source `Authorization`. Reuse an existing compatible authorizer or configure an Events-specific one later; do not change the guest methods or their authorizer.
2. **Set nonempty method Authorization Scopes** to a scope actually present in current frontend access tokens. For the existing Amplify username/password (Cognito API) sign-in flow, the compatibility scope is normally `aws.cognito.signin.user.admin`. Confirm that the actual sign-in token contains it, then use that scope on all five Events methods. It is an access-token compatibility gate; SQL membership and OWNER checks remain the application permissions. Do not require newly invented custom scopes that current sign-in cannot issue.
3. Do not configure the authorizer's optional Token validation/audience regular expression for ID-token `aud`; access tokens use `client_id` and may lack that audience. Empty method scopes select ID-token behavior, which is incompatible with this adapter. If the team already issues custom API scopes, retain the applicable existing scope instead of changing the frontend flow. [AWS method scope and validation configuration](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enable-cognito-user-pool.html).
4. Gateway performs signature, expiry, issuer and method-scope authorization. Lambda accepts identity **only** from `requestContext.authorizer.claims.sub`, checks a nonblank string of at most 128 characters, and additionally requires `token_use=access`, `client_id=COGNITO_CLIENT_ID`, and the issuer matching `COGNITO_USER_POOL_ID`. ID tokens, missing context, wrong client/pool, flat principalId and client-provided IDs are rejected. Claims are not independently signature-verified in this Lambda: the authenticated Gateway integration is the trust boundary.
5. No public Lambda function URL. Grant Gateway invocation only for the intended API/account/stage/Events method ARNs (and OPTIONS if integrated with Lambda). Restrict direct `lambda:InvokeFunction` privileges to trusted deployment/operators: a caller with direct invocation permission can manufacture an authorizer context. Client headers cannot populate the Gateway-generated context through proxy integration.
6. Test actual method requests through the deployed API in a later authorized deployment. The console's Cognito authorizer test supports ID-token testing, not access-token method validation. Missing/expired/wrong-scope tokens should fail at Gateway; its rejection response may differ from Lambda's existing `{error:string}` responses. [AWS access-token claims and scopes](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html).

No Cognito API calls or JWKS downloads occur in the Events Lambda authorizer path, so it does not require Cognito IAM permissions or a Cognito endpoint for request authentication. Local HTTP authentication continues to use the existing verifier.

## Environment variables

| Variable | Required value / behavior |
| --- | --- |
| `DB_SECRET_ARN` | Existing Secrets Manager database credential secret ARN; mandatory for the deployed Events handler |
| `DB_HOST` | Actual DNS endpoint of existing `eventwise-db`, not the instance identifier or localhost |
| `DB_NAME` | `eventwise` |
| `DB_PORT` | Actual RDS port, normally `3306`; secret mode defaults to 3306, but set explicitly |
| `COGNITO_USER_POOL_ID` | Existing intended pool, e.g. `us-west-2_<pool>`; used to check authorizer issuer |
| `COGNITO_CLIENT_ID` | Existing organizer app client ID; used to check authorizer client_id |
| `GUESTS_TABLE_NAME` | Exact existing guest table, normally `EventWise_Guests`; set explicitly to avoid environment mixups |
| `EVENTS_CORS_ORIGIN` | Exact organizer origin, e.g. `https://<branch>.<app>.amplifyapp.com`; omit for same-origin access |
| `DB_CONNECTION_LIMIT` | Start conservatively, e.g. `2`; size against reserved concurrency and database connection budget (existing default 5) |
| `DB_CONNECT_TIMEOUT_MS` | Optional; existing default 10000 |
| `DB_SSL_CA_FILE` | Optional override; packaged default resolves to `/var/task/certs/rds-ca.pem` |
| `AWS_REGION` | Supplied by Lambda; function/table/secret should be in the intended region |
| `TZ` | Set explicitly to the agreed event calendar timezone (e.g. `America/Vancouver` if that is the team's rule). EventService uses local calendar today; do not accidentally change date validation by adopting Lambda's UTC default |

Do not set `DYNAMODB_ENDPOINT` in AWS: this Lambda fails closed when it is present. Do not supply DB_USER/DB_PASSWORD or include .env files in the artifact. The real-service adapter requires secret ARN/host/database and never selects local credential mode. Injected services in isolated tests do not require RDS configuration.

Secret JSON must contain nonempty string `username` and `password`; host/database remain environment variables even if the secret contains other keys. The existing pool retrieves the secret lazily, deduplicates initialization and reuses the pool in warm environments. Secret failures do not fall back to plaintext credentials. Password bytes are preserved, including whitespace. TLS uses the packaged RDS trust bundle, `rejectUnauthorized=true` and `verifyIdentity=true`; a missing CA fails. Use the RDS DNS endpoint to match its certificate. Credentials remain cached until the execution environment is recycled; periodic secret-rotation refresh is not implemented.

## IAM, database permissions and VPC connectivity

Execution role trust: `lambda.amazonaws.com`. Required access:

- `secretsmanager:GetSecretValue` on the existing secret ARN; `kms:Decrypt` on its key when a customer-managed KMS key requires it, with compatible key policy. No secret mutation/list-all permission is needed.
- `dynamodb:Query` and `dynamodb:BatchWriteItem` on the **existing guest table ARN** for deletion cleanup. No Scan, CreateTable, table deletion, guest API invocation or broad DynamoDB grants are needed.
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` for `/aws/lambda/eventwise-events` as appropriate to the team's log-group provisioning.
- Lambda VPC ENI permissions, e.g. the approved `AWSLambdaVPCAccessExecutionRole` equivalent. AWS lists CreateNetworkInterface, DescribeNetworkInterfaces, DescribeSubnets, DeleteNetworkInterface, AssignPrivateIpAddresses and UnassignPrivateIpAddresses on `*`. [AWS VPC permissions](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html).

API Gateway's separate function resource policy needs `lambda:InvokeFunction` for principal `apigateway.amazonaws.com`, restricted by source account and exact existing API/stage/method/resource ARN. No `rds-db:connect` is needed for the current secret/password SQL authentication. SQL grants are separate from IAM: use the existing approved application account with Events' SELECT/INSERT/UPDATE/DELETE rights, including template reads, membership/category initialization, deletion reference checks and cascades. Do not use the migration account just to avoid grants. Review these against `EventRepository`; no schema modifications are required.

Attach **this function** to the existing EventWise VPC/private subnets and approved Lambda security group. Existing connectivity for another function does not attach `eventwise-events` automatically. RDS security group permits the Lambda SG on the database port; Lambda egress/NACLs/DNS permit return traffic and service access.

For private subnets without NAT, confirm/reuse:

- Secrets Manager **interface endpoint** `com.amazonaws.<region>.secretsmanager`, private DNS enabled, endpoint SG ingress TCP 443 from Lambda SG, and an endpoint policy permitting this role/secret.
- DynamoDB **gateway endpoint** `com.amazonaws.<region>.dynamodb`, associated with **all route tables used by the Lambda subnets**, allowing the guest table and role; allow HTTPS egress to the DynamoDB managed prefix list and suitable NACL traffic. The endpoint/table region must match.

Database access alone does not give either SDK service access. Existing NAT connectivity is an alternative; do not create duplicate endpoints. Secrets Manager's service-side KMS decryption does not require the function to call a KMS endpoint directly. Normal Lambda stdout logging is delivered by the Lambda service; no application CloudWatch Logs SDK call is made. [Secrets Manager endpoints](https://docs.aws.amazon.com/secretsmanager/latest/userguide/vpc-endpoint-overview.html), [DynamoDB gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-ddb.html).

## Event deletion behavior retained

OWNER authorization and SQL locks precede deletion. Any expense payment/refund history or protected cross-event references returns 409. SQL removes expenses, deletes the event and commits with existing FK cascades. Only after that commit does the service await guest deletion in the same event partition: paginated Query, BatchWriteItem chunks of 25, and bounded retry of unprocessed items.

Guest cleanup failure logs an error and still returns **204**, because SQL already committed. There is no durable replay queue; repeated event DELETE returns 404, not a cleanup retry. SQL and DynamoDB are not one atomic transaction. Concurrent guest writes/event existence enforcement and durable recovery remain operational concerns, not changes in this adapter. Confirm this function and the guest API use the same region/table. Keep enough timeout for the SQL transaction and cleanup; a process timeout after commit can interrupt cleanup. Review cleanup failures in logs; a 204 alone does not prove guest removal.

No existing guest API handler, Gateway route, table definition or schema was modified. Guest-service code is included only because EventService already calls its cleanup repository.

## Build and ZIP creation (local only)

From repository root:

```powershell
npm --prefix backend ci --ignore-scripts --no-audit --no-fund
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run package:events
```

Output: **`backend/build/eventwise-events.zip`** (ignored build artifact). Packaging uses Node/npm and Windows tar.exe, or `zip` on Linux/macOS. It stages files under backend/build, installs lockfile-pinned **production** dependencies, smoke-loads the handler and parses the CA certificate, creates the ZIP and removes its own temporary staging directory. Production installation requires registry/cache access. It does not call AWS.

ZIP root contains:

```text
event-service/lambda/events.js
event-service/handlers/...
event-service/services/...
event-service/repositories/...
guest-service/...
expense-service/...       # shared authentication imports expense-service/errors
vendor-service/...
shared/...
certs/rds-ca.pem
node_modules/...          # all lockfile production dependencies, including AWS SDKs
package.json
package-lock.json
```

No local .env, SQL schema/seeds, server.ts/server.js listener, test directory, development dependencies or AWS credentials are copied. Other compiled feature modules are included to retain transitive imports, but are not routed by this handler. Production dependencies are explicitly packaged rather than relying on a particular runtime-bundled SDK version. Existing package:templates behavior is unchanged.

## Later deployment checklist — do not execute during implementation review

1. Record/export the current API configuration and integration IDs; confirm the existing RDS endpoint, secret ARN, VPC/subnets/SGs and table ARN. Coordinate with the resource owner. Preserve current guest/template resources, authorizers and integrations; do not import a replacement whole-API specification.
2. Create/update only the approved `eventwise-events` deployment with the ZIP, handler path above, supported Node.js runtime compatible with Node >=22.12 (e.g. Node.js 22), role, VPC attachment and environment. Start with conservative concurrency, measured memory/timeout, log retention and a version/alias rollback target. Do not run migrations or seeds.
3. Add/adjust only GET/POST `/events` and GET/PATCH/DELETE `/events/{eventId}` using REST proxy integration and the access-token authorizer/scopes described above. Leave every guest resource/method/integration unchanged. Do not attach an ANY catch-all that would intercept other features.
4. Configure unauthenticated OPTIONS on these two Events resources (Lambda proxy to this handler or equivalent mock integration). Set EVENTS_CORS_ORIGIN for cross-origin requests; the adapter adds headers to success/error responses and returns 204 for OPTIONS without auth/DB calls. Verify existing Gateway-generated 401/403/5xx CORS behavior with the cloud owner; global GatewayResponse changes affect other routes and must not be changed as a side effect of this Events deployment.
5. Deploy the existing REST API to the approved stage after review. Confirm frontend event API base URL includes the stage and that Authorization/Content-Type preflight succeeds. Do not change guest API URL or its methods.
6. Later staging smoke tests: list scoped to caller, create/template category initialization, detail, owner PATCH, co-planner/unrelated denial, malformed requests, expired/wrong-client tokens, and OWNER DELETE using disposable event/guest fixtures. Verify actual RDS persistence and DynamoDB record removal. Test cleanup failure only in an isolated environment; preserve current 204 semantics.
7. Compare guest route integrations before/after and run the guest owner's agreed regression checks. Roll back Events integration/alias independently if necessary. Rollback does not undo committed event deletions or recreate guests.

## Automated verification

`backend/tests/events.lambda.test.ts` exercises all five existing handlers with the real EventService and injected repositories, access-token authorizer context validation, spoof rejection, membership/ownership/404, JSON/media-type/base64/decoded-byte limits, exact IDs/response envelopes, conflicts/internal errors, SQL-before-guest cleanup including failure/204, resource/path matching, CORS/OPTIONS and concurrent identity isolation.

The full backend suite also reruns original local HTTP handler, SQL transaction fake, DynamoDB batching/retry, template Lambda, Secrets Manager and verified TLS tests. Opt-in MySQL tests remain skipped unless deliberately enabled against an approved disposable database. These automated tests do not validate a deployed Gateway authorizer, real VPC routing, RDS credentials or real DynamoDB deletion. Those require the later authorized staging checks above.

Implementation verification: backend typecheck passed; `npm test` passed with **212 passed, 13 opt-in MySQL tests skipped, 0 failed** (225 total), including 12 new adapter tests with multiple route/auth/error cases. `npm run package:events` produced the ZIP successfully. An extracted-ZIP smoke check blocked dependency resolution outside the archive, loaded the handler, parsed the RDS CA, and confirmed a missing-authorizer request returns 401. No deployment or live AWS/database verification was performed.
