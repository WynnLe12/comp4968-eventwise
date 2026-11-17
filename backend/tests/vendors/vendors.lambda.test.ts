import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import type { ApiRequest, RouteDef } from "../../shared/http/routes";
import { vendorRoutes } from "../../vendor-service/handlers/vendorRoutes";
import { createVendorsHandler, type VendorsProxyEvent } from "../../vendor-service/lambda/vendors";

const POOL = "us-west-2_testpool";
const CLIENT = "testclient";
const ENV = { COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT } as NodeJS.ProcessEnv;
const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;
const LIST = "/events/{eventId}/vendors";
const ONE = "/events/{eventId}/vendors/{vendorId}";

function accessClaims(overrides: Record<string, unknown> = {}) {
  return { sub: "user-1", token_use: "access", client_id: CLIENT, iss: ISSUER, ...overrides };
}

function event(partial: Partial<VendorsProxyEvent> & Pick<VendorsProxyEvent, "httpMethod" | "resource">,
  claims: Record<string, unknown> | null = accessClaims()): VendorsProxyEvent {
  return { requestContext: { authorizer: { claims } }, ...partial };
}

/** Fake routes record what reached them, so no database is needed. */
function fakeRoutes() {
  const calls: ApiRequest[] = [];
  const routes: RouteDef[] = [
    { method: "GET", path: LIST, async handle(r) { calls.push(r); return { status: 200, body: [{ id: 1 }] }; } },
    { method: "POST", path: LIST, async handle(r) { calls.push(r); return { status: 201, body: r.body }; } },
    { method: "DELETE", path: ONE, async handle(r) { calls.push(r); return { status: 204 }; } },
    {
      method: "PATCH", path: ONE,
      async handle() { throw new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", { name: "Required" }); },
    },
    { method: "GET", path: ONE, async handle() { throw new Error("private database details"); } },
  ];
  return { routes, calls };
}

test("routes by resource and passes path params, query and the verified sub", async () => {
  const { routes, calls } = fakeRoutes();
  const result = await createVendorsHandler(routes, ENV)(event({
    httpMethod: "GET", resource: LIST, pathParameters: { eventId: "42" }, queryStringParameters: { q: "x" },
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.isBase64Encoded, false);
  assert.match(result.headers["Content-Type"]!, /application\/json/);
  assert.deepEqual(JSON.parse(result.body), [{ id: 1 }]);
  assert.equal(calls[0]!.sub, "user-1");
  assert.equal(calls[0]!.params.eventId, "42");
  assert.equal(calls[0]!.query.get("q"), "x");
});

test("parses JSON bodies, including base64", async () => {
  const { routes } = fakeRoutes();
  const handler = createVendorsHandler(routes, ENV);
  for (const [body, isBase64Encoded] of [
    ['{"name":"A"}', false],
    [Buffer.from('{"name":"A"}').toString("base64"), true],
  ] as const) {
    const result = await handler(event({ httpMethod: "POST", resource: LIST, body, isBase64Encoded }));
    assert.equal(result.statusCode, 201);
    assert.deepEqual(JSON.parse(result.body), { name: "A" });
  }
});

test("invalid JSON is 400 INVALID_JSON and the route never runs", async () => {
  const { routes, calls } = fakeRoutes();
  const result = await createVendorsHandler(routes, ENV)(event({ httpMethod: "POST", resource: LIST, body: "{nope" }));
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error.code, "INVALID_JSON");
  assert.equal(calls.length, 0);
});

const badIdentities: [string, Record<string, unknown> | null][] = [
  ["no authorizer claims", null],
  ["an ID token", accessClaims({ token_use: "id" })],
  ["another app client", accessClaims({ client_id: "other" })],
  ["another user pool", accessClaims({ iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_other" })],
  ["a blank sub", accessClaims({ sub: " " })],
  ["a non-string sub", accessClaims({ sub: 7 })],
  ["an oversized sub", accessClaims({ sub: "x".repeat(129) })],
];
for (const [label, claims] of badIdentities) {
  test(`rejects ${label} with 401 before the route runs`, async () => {
    const { routes, calls } = fakeRoutes();
    const result = await createVendorsHandler(routes, ENV)(event({ httpMethod: "GET", resource: LIST }, claims));
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).error.code, "UNAUTHENTICATED");
    assert.equal(calls.length, 0);
  });
}

test("rejects every request when Cognito settings are missing", async () => {
  const { routes, calls } = fakeRoutes();
  const result = await createVendorsHandler(routes, {} as NodeJS.ProcessEnv)(event({ httpMethod: "GET", resource: LIST }));
  assert.equal(result.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("204 responses have an empty body", async () => {
  const { routes } = fakeRoutes();
  const result = await createVendorsHandler(routes, ENV)(event({
    httpMethod: "DELETE", resource: ONE, pathParameters: { eventId: "1", vendorId: "2" },
  }));
  assert.equal(result.statusCode, 204);
  assert.equal(result.body, "");
});

test("ApiError keeps the contract error shape, with fields", async () => {
  const { routes } = fakeRoutes();
  const result = await createVendorsHandler(routes, ENV)(event({ httpMethod: "PATCH", resource: ONE, body: "{}" }));
  assert.equal(result.statusCode, 422);
  assert.deepEqual(JSON.parse(result.body), {
    error: { code: "VALIDATION_ERROR", message: "Check the submitted fields.", fields: { name: "Required" } },
  });
});

test("unexpected errors are logged without details and return a generic 500", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const { routes } = fakeRoutes();
  const result = await createVendorsHandler(routes, ENV)(event({ httpMethod: "GET", resource: ONE }));
  assert.equal(result.statusCode, 500);
  assert.equal(JSON.parse(result.body).error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(result.body, /private/);
  assert.equal(log.mock.callCount(), 1);
});

test("OPTIONS is 204 without auth; CORS headers only when VENDORS_CORS_ORIGIN is set", async () => {
  const { routes, calls } = fakeRoutes();
  const plain = await createVendorsHandler(routes, ENV)(event({ httpMethod: "OPTIONS", resource: LIST }, null));
  assert.equal(plain.statusCode, 204);
  assert.equal(plain.body, "");
  assert.equal(plain.headers["Access-Control-Allow-Origin"], undefined);

  const origin = "https://organizer.example";
  const handler = createVendorsHandler(routes, { ...ENV, VENDORS_CORS_ORIGIN: origin });
  const preflight = await handler(event({ httpMethod: "OPTIONS", resource: ONE }, null));
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], origin);
  assert.match(preflight.headers["Access-Control-Allow-Methods"]!, /PATCH/);
  const unauth = await handler(event({ httpMethod: "GET", resource: LIST }, null));
  assert.equal(unauth.statusCode, 401);
  assert.equal(unauth.headers["Access-Control-Allow-Origin"], origin);
  assert.equal(calls.length, 0);
});

test("unknown resources and methods are 404", async () => {
  const { routes } = fakeRoutes();
  const handler = createVendorsHandler(routes, ENV);
  assert.equal((await handler(event({ httpMethod: "GET", resource: "/events/{eventId}" }))).statusCode, 404);
  assert.equal((await handler(event({ httpMethod: "PUT", resource: LIST }))).statusCode, 404);
});

test("the real vendor routes match the five API Gateway resources and methods", () => {
  assert.deepEqual(
    vendorRoutes.map((r) => `${r.method} ${r.path}`).sort(),
    [`DELETE ${ONE}`, `GET ${LIST}`, `GET ${ONE}`, `PATCH ${ONE}`, `POST ${LIST}`],
  );
});
