import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createEventsHandler, type EventsProxyEvent } from "../event-service/lambda/events";
import { InvitationInactiveError } from "../event-service/repositories/invitationRepository";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../event-service/services/eventService";
import { InvitationService } from "../event-service/services/invitationService";
import { createCognitoVerifiedEmailResolver, createVerifiedEmailResolver, EmailVerificationUnavailableError } from "../shared/auth/verifiedEmail";

const env = {
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
  EVENTS_CORS_ORIGIN: "https://organizer.example",
};
const path = "/event-invitations/accept";
const token = Buffer.alloc(32, 11).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const accessToken = "test-access-token";
const sub = "verified-cognito-sub";
const attributes = [
  { Name: "sub", Value: sub }, { Name: "email", Value: " Planner@Example.com " }, { Name: "email_verified", Value: "true" },
];
const membership = { event_id: "9007199254740993", member_id: "18446744073709551615", role: "CO_PLANNER" as const };

function proxy(): EventsProxyEvent {
  return {
    httpMethod: "POST", path, resource: path, pathParameters: null,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    requestContext: { authorizer: { claims: {
      sub, token_use: "access", client_id: env.COGNITO_CLIENT_ID,
      iss: `https://cognito-idp.us-west-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
    } } },
  };
}

function fixture(getUser: Parameters<typeof createVerifiedEmailResolver>[0] = async () => ({ UserAttributes: attributes })) {
  const cognitoCalls: string[] = [];
  const repositoryCalls: string[][] = [];
  let failure: Error | undefined;
  const acceptance = new InvitationService({
    async create() { assert.fail("Acceptance must not create an invitation"); },
    async finishEmail() { assert.fail("Acceptance must not queue an email"); },
    async list() { assert.fail("Acceptance must not list invitations"); },
    async revoke() { assert.fail("Acceptance must not revoke an invitation"); },
    async accept(digest, subject, email) {
      repositoryCalls.push([digest, subject, email]);
      if (failure) throw failure;
      return membership;
    },
  });
  const resolveVerifiedEmail = createVerifiedEmailResolver(async bearer => {
    cognitoCalls.push(bearer);
    return getUser(bearer);
  });
  return { handler: createEventsHandler({ acceptance, resolveVerifiedEmail, env }), cognitoCalls, repositoryCalls,
    fail(error: Error) { failure = error; } };
}

test("acceptance sends the bearer to GetUser and only the digest and verified identity to MySQL", async () => {
  const f = fixture();
  const event = proxy();
  event.body = Buffer.from(event.body!).toString("base64");
  event.isBase64Encoded = true;
  event.headers!["x-user-id"] = "spoofed";
  const result = await f.handler(event);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  assert.deepEqual(JSON.parse(result.body), membership);
  assert.deepEqual(f.cognitoCalls, [accessToken]);
  assert.deepEqual(f.repositoryCalls, [[hash, sub, "planner@example.com"]]);
});

test("invalid invite tokens and extra identity fields never reach Cognito or SQL", async () => {
  const f = fixture();
  for (const body of [{}, { token: 123 }, { token: "too-short" }, { token: token + "=" },
    { token: token.slice(0, -1) + "B" }, { token, email: "spoofed@example.com" }, { token, sub }, { token, role: "OWNER" }, { token, event_id: "1" }]) {
    const response = await f.handler({ ...proxy(), body: JSON.stringify(body) });
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(f.cognitoCalls, []);
  assert.deepEqual(f.repositoryCalls, []);
});

test("acceptance requires both the Gateway access-token subject and exactly one bearer token", async () => {
  const f = fixture();
  const invalidClaims = proxy();
  invalidClaims.requestContext!.authorizer!.claims!.token_use = "id";
  for (const event of [
    { ...proxy(), requestContext: undefined }, invalidClaims,
    { ...proxy(), headers: {} },
    { ...proxy(), multiValueHeaders: { Authorization: [`Bearer ${accessToken}`, "Bearer second-token"] } },
  ]) {
    assert.equal((await f.handler(event)).statusCode, 401);
  }
  assert.deepEqual(f.cognitoCalls, []);
  assert.deepEqual(f.repositoryCalls, []);
});

test("GetUser must return one matching subject, one email and explicit verification", async () => {
  for (const UserAttributes of [undefined, attributes.slice(1), attributes.filter(value => value.Name !== "email"),
    [...attributes, attributes[1]], [
      ...attributes.slice(0, 2), { Name: "email_verified", Value: "false" },
    ], [{ Name: "sub", Value: "different-account" }, ...attributes.slice(1)]]) {
    const f = fixture(async () => ({ UserAttributes }));
    const response = await f.handler(proxy());
    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), { error: "A matching verified email is required" });
    assert.deepEqual(f.repositoryCalls, []);
  }
});

test("enforces literal Gateway resource, method and absent path parameters; OPTIONS bypasses auth", async () => {
  const f = fixture();
  for (const event of [
    { ...proxy(), httpMethod: "GET" }, { ...proxy(), path: path + "/" },
    { ...proxy(), resource: "/event-invitations/{action}" }, { ...proxy(), pathParameters: { eventId: "1" } },
  ]) {
    assert.equal((await f.handler(event)).statusCode, 404);
  }
  const preflight = await f.handler({ ...proxy(), httpMethod: "OPTIONS", requestContext: undefined });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.body, "");
  assert.deepEqual(f.cognitoCalls, []);
});

test("domain errors and Cognito outages return safe responses; errors never log credentials", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const f = fixture();
  for (const [error, status] of [
    [new EventAccessDeniedError("A matching verified email is required"), 403],
    [new EventNotFoundError("Invitation not found"), 404],
    [new EventConflictError("This invitation has already been accepted"), 409],
    [new InvitationInactiveError("This invitation has expired or been revoked"), 410],
    [new Error(`private SQL error ${hash} ${token}`), 500],
  ] as const) {
    f.fail(error);
    const response = await f.handler(proxy());
    assert.equal(response.statusCode, status);
    for (const value of [hash, token, accessToken]) assert.ok(!response.body.includes(value));
  }
  for (const [name, status] of [["TooManyRequestsException", 503], ["TimeoutError", 503], ["NotAuthorizedException", 401]] as const) {
    const unavailable = fixture(async () => { throw Object.assign(new Error(`private ${accessToken}`), { name }); });
    const result = await unavailable.handler(proxy());
    assert.equal(result.statusCode, status);
    assert.ok(!result.body.includes(accessToken));
    assert.deepEqual(unavailable.repositoryCalls, []);
  }
  assert.deepEqual(logs, [["Event invitation operation failed", {
    operation: "accept", step: undefined, errorType: "Error", errorMessage: "Unrecognized error details omitted.",
    mysqlCode: undefined, mysqlErrno: undefined,
  }]]);
});

test("production email lookup fails closed until the pool case policy is confirmed", async () => {
  const resolve = createCognitoVerifiedEmailResolver(env);
  await assert.rejects(resolve(accessToken, sub), EmailVerificationUnavailableError);
});
