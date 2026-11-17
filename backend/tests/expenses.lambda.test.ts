import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createExpensesHandler, type ExpensesProxyEvent } from "../expense-service/lambda/expenses";
import { createAppServer } from "../server";
import { input, setup } from "./fixtures/expenses";

const env = { COGNITO_USER_POOL_ID: "us-west-2_test", COGNITO_CLIENT_ID: "organizer", EXPENSES_CORS_ORIGIN: "http://localhost:5173" };
const claims = { sub: "owner", token_use: "access", client_id: env.COGNITO_CLIENT_ID, iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_test" };
function event(path = "/events/400/expenses", method = "GET", body?: unknown): ExpensesProxyEvent {
  return { path, httpMethod: method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body), requestContext: { authorizer: { claims: { ...claims } } } };
}
function harness() {
  const fixture = setup();
  return { ...fixture, handle: createExpensesHandler({ service: fixture.service, env }) };
}
const data = (response: { body: string }) => JSON.parse(response.body).data;

test("Expenses Lambda routes CRUD, summary and payments through real services with exact string values", async () => {
  const { handle } = harness();
  assert.equal((await handle(event())).statusCode, 200);
  assert.equal(data(await handle(event("/events/400/expenses/4001"))).committedAmount, "1200.00");
  assert.equal(data(await handle(event("/events/400/expenses/summary"))).outstandingTotal, "1000.00");
  const created = await handle(event(undefined, "POST", { ...input, committedAmount: "0.30" }));
  assert.equal(created.statusCode, 201);
  const id = data(created).expenseId;
  assert.equal(id, "9007199254740993");
  assert.equal(created.headers.Location, `/events/400/expenses/${id}`);
  const path = `/events/400/expenses/${id}`;
  assert.equal(data(await handle(event(path, "PATCH", { description: "Updated" }))).description, "Updated");
  const payment = await handle(event(path + "/payments", "POST", { amount: "0.10", paidAt: "2026-11-11" }));
  assert.equal(payment.statusCode, 201);
  assert.equal(data(payment).payment.paymentId, "9007199254740993");
  assert.equal(data(payment).expense.outstandingAmount, "0.20");
  assert.equal(data(await handle(event(path + "/payments")))[0].amount, "0.10");
  assert.equal((await handle(event(path + "/payments", "POST", { amount: "0.21", paidAt: "2026-11-11" }))).statusCode, 409);
  // Existing business rule forbids deletion of expenses with payment history.
  assert.equal((await handle(event(path, "DELETE"))).statusCode, 409);
  const fresh = harness();
  const empty = data(await fresh.handle(event(undefined, "POST", input))).expenseId;
  const removed = await fresh.handle(event(`/events/400/expenses/${empty}`, "DELETE"));
  assert.equal(removed.statusCode, 204); assert.equal(removed.body, "");
});

test("Expenses Lambda denies missing, forged, wrong-pool/client and ID-token identity before service calls", async () => {
  const { handle, repository } = harness();
  repository.transaction = async () => { throw new Error("must not reach database"); };
  for (const bad of [undefined, {}, { ...claims, sub: "" }, { ...claims, sub: " ".repeat(3) },
    { ...claims, sub: "x".repeat(129) }, { ...claims, token_use: "id" },
    { ...claims, client_id: "other" }, { ...claims, iss: "https://other" }]) {
    const request = event();
    request.requestContext = { authorizer: { claims: bad } };
    request.headers = { Authorization: "Bearer forged", "X-User-Id": "owner" };
    const response = await handle(request);
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).error.code, "UNAUTHENTICATED");
  }
  assert.equal((await createExpensesHandler({ env: {} })(event())).statusCode, 401);
  assert.equal((await createExpensesHandler({ env })(event())).statusCode, 503);
});

test("Expenses Lambda preserves event membership and cross-event expense checks for every operation", async () => {
  const { handle } = harness();
  for (const request of [event(), event(undefined, "POST", input), event("/events/400/expenses/summary"),
    event("/events/400/expenses/4001"), event("/events/400/expenses/4001", "PATCH", { description: "x" }),
    event("/events/400/expenses/4001", "DELETE"), event("/events/400/expenses/4001/payments"),
    event("/events/400/expenses/4001/payments", "POST", { amount: "1.00", paidAt: "2026-11-11" })]) {
    request.requestContext!.authorizer!.claims!.sub = "outsider";
    assert.equal((await handle(request)).statusCode, 403);
  }
  for (const request of [event("/events/400/expenses/4010"), event("/events/400/expenses/4010", "PATCH", { description: "x" }),
    event("/events/400/expenses/4010", "DELETE"), event("/events/400/expenses/4010/payments"),
    event("/events/400/expenses/4010/payments", "POST", { amount: "1.00", paidAt: "2026-11-11" })]) {
    assert.equal((await handle(request)).statusCode, 404);
  }
});

test("Expenses Lambda preserves repeated query keys, multi-value precedence and encoded characters", async () => {
  const { handle, service } = harness();
  let captured: unknown;
  const original = service.list.bind(service);
  service.list = async (id, sub, query) => { captured = query; return original(id, sub, query); };
  const request = event();
  request.queryStringParameters = { limit: "bad", q: "a+b & 50%" };
  request.multiValueQueryStringParameters = { limit: ["5"] };
  assert.equal((await handle(request)).statusCode, 200);
  assert.deepEqual(captured, { limit: 5, offset: 0, q: "a+b & 50%" });
  request.multiValueQueryStringParameters.limit = ["5", "10"];
  assert.equal((await handle(request)).statusCode, 422);
  for (const path of ["/events/400/expenses/summary", "/events/400/expenses/4001", "/events/400/expenses/4001/payments"]) {
    const bad = event(path); bad.multiValueQueryStringParameters = { limit: ["1", "2"] };
    assert.equal((await handle(bad)).statusCode, 422);
  }
});

test("Expenses Lambda preserves JSON, media type and decoded body-size validation", async () => {
  const { handle } = harness();
  const encoded = event(undefined, "POST", input);
  encoded.headers = { "content-type": "text/plain" };
  encoded.multiValueHeaders = { "Content-Type": ["application/json; charset=utf-8"] };
  encoded.body = Buffer.from(encoded.body!).toString("base64"); encoded.isBase64Encoded = true;
  assert.equal((await handle(encoded)).statusCode, 201);
  const malformed = event(undefined, "POST"); malformed.body = "{";
  assert.equal((await handle(malformed)).statusCode, 400);
  const plain = event(undefined, "POST", input); plain.headers = { "Content-Type": "text/plain" };
  assert.equal((await handle(plain)).statusCode, 415);
  for (const base64 of [false, true]) {
    const huge = event(undefined, "POST", { ...input, description: "é".repeat(9000) });
    huge.isBase64Encoded = base64;
    if (base64) huge.body = Buffer.from(huge.body!).toString("base64");
    assert.equal((await handle(huge)).statusCode, 413);
  }
  const invalid = await handle(event(undefined, "POST", { ...input, committedAmount: 1 }));
  assert.equal(invalid.statusCode, 422); assert.ok(JSON.parse(invalid.body).error.fields);
});

test("Expenses Lambda checks exact routes and metadata, supports OPTIONS and keeps Allow/CORS headers", async () => {
  const { handle } = harness();
  for (const path of ["/events", "/events/400/vendors", "/events/400/expenses/", "/events/400/expenses/summary/payments", "/events/400/expenses/4001/payments/1"]) {
    assert.equal((await handle(event(path))).statusCode, 404);
  }
  for (const extra of [{ resource: "/events/{eventId}" }, { pathParameters: { eventId: "401" } },
    { pathParameters: { expenseId: "4010" } }]) {
    assert.equal((await handle({ ...event("/events/400/expenses/4001"), ...extra })).statusCode, 404);
  }
  const valid = { ...event("/events/400/expenses/summary"), resource: "/events/{eventId}/expenses/summary", pathParameters: { eventId: "400" } };
  assert.equal((await handle(valid)).statusCode, 200);
  const options = event(undefined, "OPTIONS"); options.requestContext = undefined;
  const preflight = await createExpensesHandler({ env })(options);
  assert.equal(preflight.statusCode, 204); assert.equal(preflight.body, "");
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], env.EXPENSES_CORS_ORIGIN);
  const method = await handle(event(undefined, "PUT"));
  assert.equal(method.statusCode, 405); assert.equal(method.headers.Allow, "GET, POST");
  assert.equal(method.headers["Access-Control-Allow-Origin"], env.EXPENSES_CORS_ORIGIN);
});

test("Expenses Lambda masks unexpected errors and keeps concurrent invocation identities separate", async () => {
  const { handle, repository } = harness();
  const requests = ["owner", "outsider", "planner", "outsider"].map(sub => {
    const request = event(); request.requestContext!.authorizer!.claims!.sub = sub; return request;
  });
  assert.deepEqual((await Promise.all(requests.map(handle))).map(r => r.statusCode), [200, 403, 200, 403]);
  repository.transaction = async () => { throw new Error("private database password"); };
  const response = await handle(event());
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes("password"));
  assert.equal(response.headers["Access-Control-Allow-Origin"], env.EXPENSES_CORS_ORIGIN);
});

test("Expenses Lambda and local HTTP return equivalent bodies, statuses and Location headers", async t => {
  const local = setup();
  const server = createAppServer({ expenses: local.service, authenticate: async () => "owner" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { handle } = harness();
  for (const request of [event(), event("/events/400/expenses/4001"), event("/events/400/expenses/summary"),
    event(undefined, "POST", input), event("/events/400/expenses/9007199254740993", "PATCH", { description: "Changed" }),
    event("/events/400/expenses/9007199254740993", "DELETE"), event("/events/400/expenses/4001/payments"),
    event("/events/400/expenses/4001/payments", "POST", { amount: "0.10", paidAt: "2026-11-11" }),
    event(undefined, "POST", { ...input, committedAmount: 1 }), event(undefined, "PUT")]) {
    const http = await fetch(base + request.path, { method: request.httpMethod, headers: { "Content-Type": "application/json" }, body: request.body });
    const lambda = await handle(request);
    assert.equal(lambda.statusCode, http.status);
    assert.equal(lambda.body, await http.text());
    assert.equal(lambda.headers.Location ?? null, http.headers.get("location"));
  }
});
