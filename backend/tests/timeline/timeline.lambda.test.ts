// Timeline Lambda tests: API Gateway proxy events in, JSON responses out.
// Uses the real TimelineService over the in-memory store (no AWS, Docker or MySQL).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ITEM_RESOURCE,
  LIST_RESOURCE,
  MAX_BODY_BYTES,
  createTimelineHandler,
  type TimelineProxyEvent,
} from "../../timeline-service/lambda/timeline";
import { TimelineService } from "../../timeline-service/services/timelineService";
import { MemoryTimelineStore, RecordingNotifier, memberships } from "./fakes";

const POOL = "us-west-2_testpool";
const CLIENT = "testclient";
const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;
const ENV = { COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT } as NodeJS.ProcessEnv;
const JSON_HEADERS = { "Content-Type": "application/json" };

function claims(sub = "sub-owner", overrides: Record<string, unknown> = {}) {
  return { sub, token_use: "access", client_id: CLIENT, iss: ISSUER, ...overrides };
}

function setup(env: NodeJS.ProcessEnv = ENV) {
  const store = new MemoryTimelineStore();
  const notifier = new RecordingNotifier();
  const service = new TimelineService({
    repository: store,
    requireMember: memberships([["42", "sub-owner"], ["42", "sub-planner"]]).check,
    notifier,
    now: () => new Date("2026-12-01T12:00:00Z"),
    logError: () => {},
  });
  return { handler: createTimelineHandler(service, env), store, notifier };
}

function request(
  partial: Partial<TimelineProxyEvent> & Pick<TimelineProxyEvent, "httpMethod" | "resource">,
  auth: Record<string, unknown> | null = claims(),
): TimelineProxyEvent {
  return { pathParameters: { eventId: "42" }, requestContext: { authorizer: { claims: auth } }, ...partial };
}

const post = (body: unknown, extra: Partial<TimelineProxyEvent> = {}) =>
  request({ httpMethod: "POST", resource: LIST_RESOURCE, headers: JSON_HEADERS, body: JSON.stringify(body), ...extra });

const ceremony = { title: "Ceremony begins", place: "Garden", startsAt: "2026-12-05T15:00:00-08:00" };

const json = (response: { body: string }) => JSON.parse(response.body);

// --- Routing and CORS -----------------------------------------------------------

test("OPTIONS on both resources is 204 with no auth; CORS headers only when configured", async () => {
  const plain = setup().handler;
  for (const resource of [LIST_RESOURCE, ITEM_RESOURCE]) {
    const response = await plain(request({ httpMethod: "OPTIONS", resource }, null));
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  }
  const cors = setup({ ...ENV, TIMELINE_CORS_ORIGIN: "http://localhost:5173" }).handler;
  const response = await cors(request({ httpMethod: "OPTIONS", resource: LIST_RESOURCE }, null));
  assert.equal(response.headers["Access-Control-Allow-Origin"], "http://localhost:5173");
  assert.equal(response.headers["Access-Control-Allow-Headers"], "Content-Type,Authorization");
  assert.match(response.headers["Access-Control-Allow-Methods"]!, /PATCH/);
});

test("unknown resources are 404 and unsupported methods are 405 with an Allow header", async () => {
  const { handler } = setup();
  const unknown = await handler(request({ httpMethod: "GET", resource: "/events/{eventId}/vendors" }));
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(json(unknown), { error: { code: "NOT_FOUND", message: "Not found." } });
  // OPTIONS on a resource this function doesn't own is not answered either.
  assert.equal((await handler(request({ httpMethod: "OPTIONS", resource: "/guests" }, null))).statusCode, 404);

  const wrong = await handler(request({ httpMethod: "DELETE", resource: LIST_RESOURCE }));
  assert.equal(wrong.statusCode, 405);
  assert.equal(wrong.headers.Allow, "GET, POST, OPTIONS");
  assert.equal(json(wrong).error.code, "METHOD_NOT_ALLOWED");
});

// --- Identity -------------------------------------------------------------------

test("only Gateway-verified access-token claims for this pool and client are accepted", async () => {
  const { handler, store } = setup();
  const cases: [string, Record<string, unknown> | null][] = [
    ["no claims", null],
    ["ID token", claims("sub-owner", { token_use: "id" })],
    ["other client", claims("sub-owner", { client_id: "other" })],
    ["other pool", claims("sub-owner", { iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_other" })],
    ["blank sub", claims("  ")],
    ["number sub", claims(42 as never)],
    ["huge sub", claims("x".repeat(129))],
  ];
  for (const [name, auth] of cases) {
    const response = await handler(post(ceremony, { requestContext: { authorizer: { claims: auth } } }));
    assert.equal(response.statusCode, 401, name);
    assert.equal(json(response).error.code, "UNAUTHENTICATED", name);
  }
  assert.equal(store.records.size, 0);

  const unconfigured = setup({} as NodeJS.ProcessEnv).handler;
  assert.equal((await unconfigured(request({ httpMethod: "GET", resource: LIST_RESOURCE }))).statusCode, 401);
});

test("identity is never taken from headers or the body", async () => {
  const { handler, store } = setup();
  const response = await handler(post({ ...ceremony }, {
    headers: { ...JSON_HEADERS, "X-User-Sub": "sub-owner" },
    requestContext: { authorizer: { claims: claims("sub-stranger") } },
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(store.records.size, 0);
});

// --- Create, list, update, delete ---------------------------------------------

test("POST creates an activity: 201, Location header and the item JSON", async () => {
  const { handler } = setup();
  const response = await handler(post(ceremony));
  assert.equal(response.statusCode, 201);
  const item = json(response);
  assert.equal(response.headers.Location, `/events/42/timeline/${item.itemId}`);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(item.startsAt, "2026-12-05T23:00:00Z");
  assert.equal(item.version, 1);
  assert.equal("createdBy" in item, false);
});

test("GET lists the event's activities in time order", async () => {
  const { handler } = setup();
  await handler(post({ title: "Dinner", startsAt: "2026-12-06T01:45:00Z" }));
  await handler(post(ceremony));
  const response = await handler(request({ httpMethod: "GET", resource: LIST_RESOURCE }));
  assert.equal(response.statusCode, 200);
  const list = json(response);
  assert.equal(list.eventId, "42");
  assert.deepEqual(list.items.map((i: { title: string }) => i.title), ["Ceremony begins", "Dinner"]);
});

test("PATCH returns the item, changed fields and notification outcome; a stale version is 409", async () => {
  const { handler, notifier } = setup();
  const created = json(await handler(post(ceremony)));
  const patch = (body: unknown, sub = "sub-planner") => handler(request({
    httpMethod: "PATCH", resource: ITEM_RESOURCE, pathParameters: { eventId: "42", itemId: created.itemId },
    headers: JSON_HEADERS, body: JSON.stringify(body),
  }, claims(sub)));

  const moved = await patch({ version: 1, startsAt: "2026-12-05T15:30:00-08:00", notify: true });
  assert.equal(moved.statusCode, 200);
  const result = json(moved);
  assert.equal(result.item.version, 2);
  assert.deepEqual(result.changedFields, ["startsAt"]);
  assert.deepEqual(result.notification, { status: "QUEUED", recipients: 3 });
  assert.equal(notifier.changes.length, 1);

  const stale = await patch({ version: 1, title: "Too late" }, "sub-owner");
  assert.equal(stale.statusCode, 409);
  assert.equal(json(stale).error.code, "VERSION_CONFLICT");
});

test("DELETE is 204 with an empty body, honours ?notify=true, then 404", async () => {
  const { handler, notifier } = setup();
  const created = json(await handler(post(ceremony)));
  const remove = (query?: Record<string, string>) => handler(request({
    httpMethod: "DELETE", resource: ITEM_RESOURCE, pathParameters: { eventId: "42", itemId: created.itemId },
    queryStringParameters: query ?? null,
  }));
  const deleted = await remove({ notify: "true" });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  assert.equal(notifier.changes[0]!.type, "DELETED");
  assert.equal((await remove()).statusCode, 404);
});

// --- Bodies -------------------------------------------------------------------

test("writes must be application/json; charset parameters are fine", async () => {
  const { handler } = setup();
  const noType = await handler(post(ceremony, { headers: {} }));
  assert.equal(noType.statusCode, 415);
  assert.equal(json(noType).error.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal((await handler(post(ceremony, { headers: { "Content-Type": "text/plain" } }))).statusCode, 415);
  assert.equal((await handler(post(ceremony, { headers: { "content-type": "application/json; charset=utf-8" } }))).statusCode, 201);
});

test("base64 bodies are decoded; malformed JSON is 400; oversized bodies are 413", async () => {
  const { handler } = setup();
  const encoded = await handler(post(null, { body: Buffer.from(JSON.stringify(ceremony)).toString("base64"), isBase64Encoded: true }));
  assert.equal(encoded.statusCode, 201);

  const malformed = await handler(post(null, { body: "{title:" }));
  assert.equal(malformed.statusCode, 400);
  assert.equal(json(malformed).error.code, "BAD_REQUEST");

  const huge = await handler(post(null, { body: JSON.stringify({ ...ceremony, notes: "x".repeat(MAX_BODY_BYTES) }) }));
  assert.equal(huge.statusCode, 413);
  assert.equal(json(huge).error.code, "PAYLOAD_TOO_LARGE");
});

test("validation errors keep the shared error envelope with fields", async () => {
  const { handler } = setup();
  const response = await handler(post({ title: "", startsAt: "soon" }));
  assert.equal(response.statusCode, 422);
  assert.deepEqual(json(response), {
    error: {
      code: "VALIDATION_ERROR",
      message: "Check the submitted fields.",
      fields: {
        title: "Required.",
        startsAt: "Use a date and time with a time zone and whole minutes, e.g. 2026-12-05T15:00:00-08:00.",
      },
    },
  });
});

// --- Failures and concurrency ---------------------------------------------------

test("unexpected errors are a generic 500 and the log holds no details", async () => {
  const { handler, store } = setup();
  store.listItems = async () => { throw new Error("Table EventWise_Timeline: guest@example.com"); };
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const response = await handler(request({ httpMethod: "GET", resource: LIST_RESOURCE }));
    assert.equal(response.statusCode, 500);
    assert.deepEqual(json(response), { error: { code: "INTERNAL_ERROR", message: "Unable to complete the request." } });
  } finally {
    console.error = original;
  }
  assert.equal(JSON.stringify(logged).includes("example.com"), false);
  assert.deepEqual(logged, [["GET /events/{eventId}/timeline failed", "Error"]]);
});

test("concurrent warm invocations keep each caller's identity separate", async () => {
  const { handler } = setup();
  const responses = await Promise.all([
    handler(post(ceremony)),
    handler(post(ceremony, { requestContext: { authorizer: { claims: claims("sub-stranger") } } })),
    handler(post({ ...ceremony, title: "Dinner" }, { requestContext: { authorizer: { claims: claims("sub-planner") } } })),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode), [201, 403, 201]);
});
