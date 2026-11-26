import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import { parseCreateDraft, parseDraftConfirmation, parseDraftPatch, parseDraftVersion } from "../../contract-service/services/draftValidation";
import { createContractsHandler, type ContractStores, type ContractsProxyEvent } from "../../contract-service/lambda/contracts";
import type { Draft } from "../../contract-service/types";

const env = { COGNITO_USER_POOL_ID: "us-west-2_test", COGNITO_CLIENT_ID: "organizer", CONTRACTS_CORS_ORIGIN: "http://localhost:5173" };
const claims = { sub: "owner", token_use: "access", client_id: env.COGNITO_CLIENT_ID,
  iss: "https://cognito-idp.us-west-2.amazonaws.com/" + env.COGNITO_USER_POOL_ID };
const base = "/events/12/contract-drafts", id = "9007199254740993", item = base + "/" + id;
const draft: Draft = {
  draftId: id, eventId: "12", documentId: "23", documentFilename: "contract.pdf", documentContentType: "application/pdf",
  description: "DJ contract", categoryId: "4", vendorId: "5", vendorName: "DJ", totalAmount: "600.10", depositAmount: "100.05",
  dueDate: null, currencyCode: "USD", saveAction: "CREATE_EXPENSE", targetExpenseId: null, confirmedExpenseId: null,
  version: "1", status: "DRAFT", createdAt: "2026-11-25 12:00:00", updatedAt: "2026-11-25 12:00:00", confirmedAt: null,
};
function event(path = base, httpMethod = "GET", body?: unknown): ContractsProxyEvent {
  return { path, httpMethod, headers: { "Content-Type": "application/json" }, body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { claims: { ...claims } } } };
}
function fixture(failure?: Error) {
  const calls: unknown[][] = [];
  const guard = (eventId: string, sub: string) => {
    if (failure) throw failure;
    if (eventId !== "12" || !["owner", "planner"].includes(sub)) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
  };
  const stores: ContractStores = {
    reader: {
      async list(eventId, sub, query) { calls.push(["list", eventId, sub, query]); guard(eventId, sub);
        return { data: [draft], total: 1, limit: query.limit, offset: query.offset }; },
      async get(eventId, draftId, sub) { calls.push(["get", eventId, draftId, sub]); guard(eventId, sub); return draftId === id ? draft : null; },
    },
    creator: { async create(eventId, documentId, sub) { calls.push(["create", eventId, documentId, sub]); guard(eventId, sub); return { draftId: id, created: true }; } },
    updater: { async update(eventId, draftId, sub, body) { calls.push(["update", eventId, draftId, sub, body]); guard(eventId, sub);
      return { ...draft, ...parseDraftPatch(body).changes, version: "2" }; } },
    discarder: { async discard(eventId, draftId, sub, body) { calls.push(["discard", eventId, draftId, sub, body]); guard(eventId, sub);
      parseDraftVersion(body); return { ...draft, status: "REJECTED", version: "2" }; } },
    confirmer: { async confirm(eventId, draftId, sub, body) { calls.push(["confirm", eventId, draftId, sub, body]); guard(eventId, sub);
      parseDraftConfirmation(body); return { draft: { ...draft, status: "CONFIRMED", version: "2", confirmedExpenseId: "9007199254740995" }, created: true }; } },
  };
  return { stores, calls, handle: createContractsHandler({ stores, env }) };
}

test("Contracts Lambda routes draft reads, creation, edits, discard and confirmation through the shared HTTP handlers", async () => {
  const { handle, calls } = fixture();
  const list = await handle(event());
  assert.equal(list.statusCode, 200); assert.deepEqual(JSON.parse(list.body).data, [draft]);
  assert.equal((await handle(event(item))).statusCode, 200);
  assert.equal((await handle(event(base + "/999"))).statusCode, 404);
  const created = await handle(event(base, "POST", { documentId: "23" }));
  assert.equal(created.statusCode, 201); assert.equal(created.headers.Location, item);
  const edited = await handle(event(item, "PATCH", { version: "1", totalAmount: "700.10" }));
  assert.equal(edited.statusCode, 200); assert.equal(JSON.parse(edited.body).data.totalAmount, "700.10");
  assert.equal(JSON.parse((await handle(event(item + "/discard", "POST", { version: "1" }))).body).data.status, "REJECTED");
  const body = { version: "1", createVendor: true };
  const confirmed = await handle(event(item + "/confirm", "POST", body));
  assert.equal(confirmed.statusCode, 201); assert.equal(confirmed.headers.Location, "/events/12/expenses/9007199254740995");
  assert.equal(confirmed.headers["Cache-Control"], "no-store"); assert.equal(confirmed.isBase64Encoded, false);
  assert.deepEqual(calls.at(-1), ["confirm", "12", id, "owner", body]);
});

test("Contracts Lambda accepts only Gateway Cognito access-token identity, never request-supplied user values", async () => {
  const { handle, calls } = fixture();
  for (const bad of [undefined, {}, { ...claims, token_use: "id" }, { ...claims, client_id: "wrong" },
    { ...claims, iss: "https://wrong" }, { ...claims, sub: "" }, { ...claims, sub: " owner " },
    { ...claims, sub: 12 }, { ...claims, sub: "x".repeat(129) }]) {
    const request = event();
    request.requestContext = { authorizer: { claims: bad } };
    request.headers = { Authorization: "Bearer forged", "X-User-Id": "owner" };
    assert.equal((await handle(request)).statusCode, 401);
  }
  assert.equal(calls.length, 0);
});

test("Contracts Lambda preflight requires no auth or database and deployed requests fail closed without secret configuration", async () => {
  const preflight = event(item + "/confirm", "OPTIONS"); preflight.requestContext = null;
  const result = await createContractsHandler({ env })(preflight);
  assert.equal(result.statusCode, 204); assert.equal(result.body, "");
  assert.equal(result.headers.Allow, "POST, OPTIONS");
  assert.equal(result.headers["Access-Control-Allow-Origin"], env.CONTRACTS_CORS_ORIGIN);
  assert.equal(result.headers["Access-Control-Expose-Headers"], "Location,Allow");
  assert.equal((await createContractsHandler({ env })(event())).statusCode, 503);
  assert.equal((await createContractsHandler({ env: {} })(event())).statusCode, 401);
  const { stores } = fixture();
  const plain = await createContractsHandler({ stores, env: { ...env, CONTRACTS_CORS_ORIGIN: "" } })(event());
  assert.equal(plain.headers["Access-Control-Allow-Origin"], undefined);
});

test("Contracts Lambda preserves event membership, verified subjects and field-level conflicts", async () => {
  const { handle, calls } = fixture();
  for (const request of [event(), event(item), event(base, "POST", { documentId: "23" }),
    event(item, "PATCH", { version: "1", description: "Edit" }), event(item + "/discard", "POST", { version: "1" }),
    event(item + "/confirm", "POST", { version: "1" })]) {
    request.requestContext!.authorizer!.claims!.sub = "outsider";
    assert.equal((await handle(request)).statusCode, 403);
  }
  assert.ok(calls.every(call => call.includes("outsider")));
  assert.equal((await handle(event("/events/13/contract-drafts/" + id))).statusCode, 403);
  const failure = new ApiError(409, "AMOUNT_BELOW_PAID", "Total is below net paid.", { totalAmount: "Keep the total above net paid." });
  const response = await fixture(failure).handle(event(item + "/confirm", "POST", { version: "1" }));
  assert.equal(response.statusCode, 409); assert.deepEqual(JSON.parse(response.body).error.fields, failure.fields);
});

test("Contracts Lambda preserves repeated queries, multi-value precedence and exact path identifiers", async () => {
  const { handle, calls } = fixture();
  const request = event();
  request.queryStringParameters = { limit: "bad", status: "DRAFT" };
  request.multiValueQueryStringParameters = { limit: ["5"] };
  assert.equal((await handle(request)).statusCode, 200);
  assert.deepEqual(calls[0], ["list", "12", "owner", { limit: 5, offset: 0, status: "DRAFT" }]);
  request.multiValueQueryStringParameters.limit = ["5", "10"];
  assert.equal((await handle(request)).statusCode, 422);
  const itemQuery = event(item); itemQuery.queryStringParameters = { eventId: "13" };
  assert.equal((await handle(itemQuery)).statusCode, 422);
  assert.equal((await handle(event("/events/12/contract-drafts/01"))).statusCode, 400);
  assert.equal((await handle(event("/events/12/contract-drafts/18446744073709551616"))).statusCode, 400);
});

test("Contracts Lambda handles base64 JSON, UTF-8 limits, media types and invalid request bodies", async () => {
  const { handle } = fixture();
  const encoded = event(base, "POST", { documentId: "23" });
  encoded.headers = { "content-type": "text/plain" };
  encoded.multiValueHeaders = { "Content-Type": ["application/json; charset=utf-8"] };
  encoded.body = Buffer.from(encoded.body!).toString("base64"); encoded.isBase64Encoded = true;
  assert.equal((await handle(encoded)).statusCode, 201);
  const malformed = event(base, "POST"); malformed.body = "{";
  assert.equal((await handle(malformed)).statusCode, 400);
  const badEncoding = event(base, "POST"); badEncoding.body = "not base64!"; badEncoding.isBase64Encoded = true;
  assert.equal((await handle(badEncoding)).statusCode, 400);
  const plain = event(base, "POST", { documentId: "23" }); plain.headers = { "Content-Type": "text/plain" };
  assert.equal((await handle(plain)).statusCode, 415);
  for (const base64 of [false, true]) {
    const huge = event(base, "POST", { padding: "\u00e9".repeat(33000) });
    huge.isBase64Encoded = base64;
    if (base64) huge.body = Buffer.from(huge.body!).toString("base64");
    assert.equal((await handle(huge)).statusCode, 413);
  }
  assert.equal((await handle(event(base, "POST", { documentId: "23", sub: "owner" }))).statusCode, 422);
  assert.equal(parseCreateDraft({ documentId: "23" }).documentId, "23");
});

test("Contracts Lambda restricts exact resources and metadata and preserves method restrictions", async () => {
  const { handle, calls } = fixture();
  for (const path of ["/events", "/events/12/vendors", base + "/", item + "/confirm/extra", item + "?eventId=13"]) {
    assert.equal((await handle(event(path))).statusCode, 404);
  }
  for (const extra of [{ resource: "/events/{eventId}/expenses/{expenseId}" }, { pathParameters: { eventId: "13" } },
    { pathParameters: { draftId: "99" } }, { version: "2.0" }]) {
    assert.equal((await handle({ ...event(item), ...extra })).statusCode, 404);
  }
  assert.equal(calls.length, 0);
  for (const [path, allow] of [[base, "GET, POST, OPTIONS"], [item, "GET, PATCH, OPTIONS"], [item + "/confirm", "POST, OPTIONS"]]) {
    const response = await handle(event(path, "DELETE"));
    assert.equal(response.statusCode, 405); assert.equal(response.headers.Allow, allow);
  }
  const valid = { ...event(item), resource: "/events/{eventId}/contract-drafts/{draftId}", pathParameters: { eventId: "12", draftId: id } };
  assert.equal((await handle(valid)).statusCode, 200);
});

test("Contracts Lambda keeps invocation identities isolated and hides private errors from responses and logs", async t => {
  const { handle } = fixture();
  const requests = ["owner", "outsider", "planner", "outsider"].map(sub => {
    const request = event(); request.requestContext!.authorizer!.claims!.sub = sub; return request;
  });
  assert.deepEqual((await Promise.all(requests.map(handle))).map(result => result.statusCode), [200, 403, 200, 403]);
  const log = t.mock.method(console, "error", () => {});
  const response = await fixture(new Error("private.sql credentials and document details")).handle(event());
  assert.equal(response.statusCode, 500); assert.doesNotMatch(response.body, /private|credentials/);
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /private.sql|credentials/);
});
