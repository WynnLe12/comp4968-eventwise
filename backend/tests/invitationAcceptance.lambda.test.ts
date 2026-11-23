import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createEventsHandler, type EventsProxyEvent } from "../event-service/lambda/events";
import { InvitationInactiveError } from "../event-service/repositories/invitationRepository";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../event-service/services/eventService";
import { InvitationService } from "../event-service/services/invitationService";

const env = {
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
  EVENTS_CORS_ORIGIN: "https://organizer.example",
  EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN: "arn:aws:execute-api:us-west-2:123456789012:hd63bpgxm8/prod/POST/event-invitations/accept",
};
const path = "/event-invitations/accept";
const token = Buffer.alloc(32, 11).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const accessToken = "test-access-token";
const sub = "verified-cognito-sub";
const membership = { event_id: "9007199254740993", member_id: "18446744073709551615", role: "CO_PLANNER" as const };

function proxy(): EventsProxyEvent {
  return {
    httpMethod: "POST", path, resource: path, pathParameters: null,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    requestContext: {
      accountId: "123456789012", apiId: "hd63bpgxm8", stage: "prod",
      authorizer: { principalId: sub, invitationAuthVersion: "1", invitationSub: sub, invitationVerifiedEmail: "planner@example.com" },
    },
  };
}

function fixture() {
  const repositoryCalls: (string | null)[][] = [];
  let failure: Error | undefined;
  const acceptance = new InvitationService({
    async create() { assert.fail("Acceptance must not create an invitation"); },
    async finishEmail() { assert.fail("Acceptance must not queue an email"); },
    async list() { assert.fail("Acceptance must not list invitations"); },
    async revoke() { assert.fail("Acceptance must not revoke an invitation"); },
    async accept(digest, subject, email, displayName) {
      repositoryCalls.push([digest, subject, email, displayName]);
      if (failure) throw failure;
      return membership;
    },
  });
  return { handler: createEventsHandler({ acceptance, env }), repositoryCalls,
    fail(error: Error) { failure = error; } };
}

test("acceptance sends only the digest and Gateway-verified identity to MySQL", async () => {
  const f = fixture();
  const event = proxy();
  event.body = Buffer.from(event.body!).toString("base64");
  event.isBase64Encoded = true;
  event.headers!["x-user-id"] = "spoofed";
  event.headers!["invitationDisplayName"] = "Client-supplied name";
  event.requestContext!.authorizer!.invitationDisplayName = "Ambrose Ch.";
  const result = await f.handler(event);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  assert.deepEqual(JSON.parse(result.body), membership);
  assert.deepEqual(f.repositoryCalls, [[hash, sub, "planner@example.com", "Ambrose Ch."]]);
});

test("acceptance stores null for absent or malformed optional authorizer names", async () => {
  const f = fixture();
  for (const displayName of [undefined, ["Ambrose Ch."], "\u202eAmbrose Ch."]) {
    const event = proxy();
    event.headers!["invitationDisplayName"] = "Client-supplied name";
    event.requestContext!.authorizer!.invitationDisplayName = displayName;
    assert.equal((await f.handler(event)).statusCode, 200);
  }
  assert.deepEqual(f.repositoryCalls, Array.from({ length: 3 }, () => [hash, sub, "planner@example.com", null]));
});

test("invalid invite tokens and extra identity fields never reach SQL", async () => {
  const f = fixture();
  for (const body of [{}, { token: 123 }, { token: "too-short" }, { token: token + "=" },
    { token: token.slice(0, -1) + "B" }, { token, email: "spoofed@example.com" }, { token, sub }, { token, role: "OWNER" },
    { token, event_id: "1" }, { token, displayName: "Client-supplied name" }]) {
    const response = await f.handler({ ...proxy(), body: JSON.stringify(body) });
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(f.repositoryCalls, []);
});

test("acceptance requires the expected Gateway context and exactly one bearer token", async () => {
  const f = fixture();
  const { requestContext } = proxy();
  const validContext = requestContext!;
  for (const event of [
    { ...proxy(), requestContext: undefined },
    { ...proxy(), requestContext: { ...validContext, apiId: "anotherapi" } },
    { ...proxy(), requestContext: { ...validContext, accountId: "999999999999" } },
    { ...proxy(), requestContext: { ...validContext, stage: "dev" } },
    { ...proxy(), headers: {} },
    { ...proxy(), multiValueHeaders: { Authorization: [`Bearer ${accessToken}`, "Bearer second-token"] } },
    { ...proxy(), headers: { Authorization: `Bearer ${accessToken}`, authorization: "Bearer second-token" } },
    { ...proxy(), multiValueHeaders: { Authorization: ["Bearer second-token"] } },
    { ...proxy(), requestContext: undefined, headers: {
      Authorization: `Bearer ${accessToken}`, invitationAuthVersion: "1", invitationSub: sub, invitationVerifiedEmail: "planner@example.com",
    } },
  ]) {
    assert.equal((await f.handler(event)).statusCode, 401);
  }
  for (const authorizer of [
    { claims: { sub, token_use: "access" } }, { principalId: sub },
    { ...validContext.authorizer, claims: {} },
    { ...validContext.authorizer, invitationAuthVersion: "2" },
    { ...validContext.authorizer, invitationSub: "" },
    { ...validContext.authorizer, invitationVerifiedEmail: "not-an-email" },
    { ...validContext.authorizer, invitationVerifiedEmail: ["planner@example.com"] },
    { ...validContext.authorizer, principalId: "different-subject" },
  ]) {
    const response = await f.handler({ ...proxy(), requestContext: { ...validContext, authorizer } });
    assert.equal(response.statusCode, 401);
  }
  assert.deepEqual(f.repositoryCalls, []);
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
});

test("domain errors return safe responses without logging credentials", async t => {
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
  assert.deepEqual(logs, [["Event invitation operation failed", {
    operation: "accept", step: undefined, errorType: "Error", errorMessage: "Unrecognized error details omitted.",
    mysqlCode: undefined, mysqlErrno: undefined,
  }]]);
});
