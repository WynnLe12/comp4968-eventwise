import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createEventsHandler, type EventsProxyEvent } from "../event-service/lambda/events";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../event-service/services/eventService";
import { InvitationService } from "../event-service/services/invitationService";

const env = {
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
  EVENTS_CORS_ORIGIN: "https://organizer.example", EVENTS_ORGANIZER_ORIGIN: "https://organizer.example/",
};
const eventId = "18446744073709551615";
const invitationId = "9007199254740993";
const path = `/events/${eventId}/invitations`;
const collection = "/events/{eventId}/invitations";
const item = collection + "/{invitationId}";
const row = {
  invitation_id: invitationId, email: "planner@example.com", status: "PENDING" as const,
  expires_at: "2026-11-24T12:00:00.000Z", created_at: "2026-11-22T12:00:00.000Z",
};

function proxy(method: string, sub = "owner"): EventsProxyEvent {
  const target = method === "DELETE";
  return {
    httpMethod: method, path: target ? `${path}/${invitationId}` : path,
    resource: target ? item : collection,
    pathParameters: target ? { eventId, invitationId } : { eventId },
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? '{"email":" Planner@EXAMPLE.com "}' : null,
    requestContext: { authorizer: { claims: {
      sub, token_use: "access", client_id: env.COGNITO_CLIENT_ID,
      iss: `https://cognito-idp.us-west-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
    } } },
  };
}

function fixture(testEnv: NodeJS.ProcessEnv = env) {
  const writes: string[][] = [];
  const authorizations: string[][] = [];
  let failure: Error | undefined;
  function authorize(id: string, sub: string) {
    authorizations.push([id, sub]);
    if (sub !== "owner") throw new EventAccessDeniedError("Only the event owner can manage invitations");
    if (failure) throw failure;
  }
  const invitations = new InvitationService({
    async create(id, sub, email, digest) { authorize(id, sub); writes.push([id, sub, email, digest]); return row; },
    async list(id, sub) { authorize(id, sub); return [row]; },
    async revoke(id, invite, sub) { authorize(id, sub); writes.push([id, invite, sub]); },
  }, testEnv);
  return {
    handler: createEventsHandler({ invitations, env: testEnv }), writes, authorizations,
    fail: (error: Error) => { failure = error; },
  };
}

test("POST normalizes email and returns a one-time link backed by a SHA-256 digest", async () => {
  const f = fixture();
  const values = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const result = await f.handler(proxy("POST"));
    assert.equal(result.statusCode, 201);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
    const { acceptance_url, ...invitation } = JSON.parse(result.body);
    assert.deepEqual(invitation, row);
    const url = new URL(acceptance_url);
    assert.equal(url.origin, "https://organizer.example");
    assert.equal(url.pathname, "/accept-invitation");
    assert.equal(url.search, "");
    const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    values.add(token);
    const hash = createHash("sha256").update(token).digest("hex");
    assert.deepEqual(f.writes[i], [eventId, "owner", "planner@example.com", hash]);
    assert.ok(!result.body.includes(hash));
  }
  assert.equal(values.size, 2);
});

test("GET returns only invitation metadata and DELETE returns empty 204", async () => {
  const f = fixture();
  const list = await f.handler(proxy("GET"));
  assert.equal(list.statusCode, 200);
  assert.deepEqual(JSON.parse(list.body), [row]);
  const revoke = await f.handler(proxy("DELETE"));
  assert.equal(revoke.statusCode, 204);
  assert.equal(revoke.body, "");
  assert.deepEqual(f.writes, [[eventId, invitationId, "owner"]]);
});

test("all invitation methods reject unauthorized roles and missing or invalid claims", async () => {
  const f = fixture();
  for (const method of ["POST", "GET", "DELETE"]) {
    for (const sub of ["co-planner", "unrelated"]) {
      const event = proxy(method, sub);
      event.headers!["X-User-Id"] = "owner";
      assert.equal((await f.handler(event)).statusCode, 403);
    }
    const missing = proxy(method);
    missing.requestContext = undefined;
    assert.equal((await f.handler(missing)).statusCode, 401);
    const invalid = proxy(method);
    invalid.requestContext!.authorizer!.claims!.token_use = "id";
    assert.equal((await f.handler(invalid)).statusCode, 401);
  }
  assert.deepEqual(f.writes, []);
  assert.equal(f.authorizations.length, 6);
});

test("invalid IDs, emails, and client identity fields fail before repository access", async () => {
  const f = fixture();
  for (const body of ['{}', '[]', '{"email":"a..b@example.com"}', '{"email":"a @example.com"}',
    '{"email":"a@example.com","invited_by_sub":"owner"}', '{"email":"a@-example.com"}', '{"email":45}', '{bad']) {
    const event = proxy("POST");
    event.body = body;
    assert.equal((await f.handler(event)).statusCode, 400);
  }
  const badEvent = proxy("GET");
  badEvent.path = "/events/0/invitations";
  badEvent.pathParameters!.eventId = "0";
  assert.equal((await f.handler(badEvent)).statusCode, 400);
  const badInvitation = proxy("DELETE");
  badInvitation.path = path + "/18446744073709551616";
  badInvitation.pathParameters!.invitationId = "18446744073709551616";
  assert.equal((await f.handler(badInvitation)).statusCode, 400);
  assert.deepEqual(f.authorizations, []);
});

test("unsupported methods and inconsistent Gateway routes are rejected before auth", async () => {
  const f = fixture();
  for (const event of [
    { ...proxy("GET"), httpMethod: "DELETE" }, { ...proxy("DELETE"), httpMethod: "GET" },
    { ...proxy("GET"), resource: item }, { ...proxy("DELETE"), resource: collection },
    { ...proxy("GET"), path: path + "/" }, { ...proxy("GET"), pathParameters: { eventId, invitationId } },
    { ...proxy("DELETE"), pathParameters: { eventId } }, { ...proxy("GET"), pathParameters: { eventId: "1" } },
    { ...proxy("DELETE"), pathParameters: { eventId, invitationId: "1" } },
  ]) {
    assert.equal((await f.handler({ ...event, requestContext: undefined })).statusCode, 404);
  }
  for (const method of ["GET", "DELETE"]) {
    const response = await f.handler({ ...proxy(method), httpMethod: "OPTIONS", requestContext: undefined });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  }
  assert.deepEqual(f.authorizations, []);
});

test("invitation errors use safe response bodies and invalid origin configuration cannot create rows", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  for (const [method, error, expected] of [
    ["POST", new EventConflictError("Duplicate"), 409],
    ["DELETE", new EventConflictError("Inactive"), 409],
    ["DELETE", new EventNotFoundError("Missing"), 404],
    ["POST", new Error("private SQL arguments"), 500],
  ] as const) {
    f.fail(error);
    const response = await f.handler(proxy(method));
    assert.equal(response.statusCode, expected);
    assert.ok(!response.body.includes("private"));
  }
  for (const origin of [undefined, "http://organizer.example", "https://organizer.example/path",
    "https://user@organizer.example", "https://organizer.example#fragment"]) {
    const invalid = fixture({ ...env, EVENTS_ORGANIZER_ORIGIN: origin });
    const response = await invalid.handler(proxy("POST"));
    assert.deepEqual(JSON.parse(response.body), { error: "Unable to complete invitation request" });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(invalid.writes, []);
  }
});
