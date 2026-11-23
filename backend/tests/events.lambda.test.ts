import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventsHandler, type EventsProxyEvent, type EventsService } from "../event-service/lambda/events";
import { EventService } from "../event-service/services/eventService";
import { EventDeletionBlockedError, MemberRemovalBlockedError, type EventRecord, type EventRepository } from "../event-service/repositories/eventRepository";

const env = {
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
  EVENTS_CORS_ORIGIN: "https://organizer.example",
  EVENTS_CREATE_METHOD_ARN: "arn:aws:execute-api:us-west-2:123456789012:hd63bpgxm8/prod/POST/events",
};
const id = "18446744073709551615";
const membersPath = `/events/${id}/members`;
const memberItemPath = `${membersPath}/2`;
const memberRows = [
  { member_id: id, cognito_sub: "owner", role: "OWNER" as const, joined_at_epoch: "1795255200", display_name: null },
  { member_id: "2", cognito_sub: "co", role: "CO_PLANNER" as const, joined_at_epoch: 1795258800, display_name: null },
];
const record: EventRecord = {
  event_id: id, name: "Wedding", template_id: "2", event_date: null, venue: null,
  total_budget: "9999999999.99", created_at: new Date("2026-11-01T12:00:00Z"), updated_at: new Date("2026-11-01T12:00:00Z"),
};
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
function proxy(method = "GET", path = "/events", sub = "owner"): EventsProxyEvent {
  const memberId = /^\/events\/[^/]+\/members\/([^/]+)$/.exec(path)?.[1];
  return {
    httpMethod: method, path, resource: path === "/events" ? "/events" :
      memberId ? "/events/{eventId}/members/{memberId}" : path.endsWith("/members") ? "/events/{eventId}/members" : "/events/{eventId}",
    pathParameters: path === "/events" ? null : { eventId: path.split("/")[2], ...(memberId ? { memberId } : {}) },
    headers: { "Content-Type": "application/json", Authorization: "Bearer deliberately-not-decoded" },
    requestContext: { authorizer: { claims: {
      sub, token_use: "access", client_id: env.COGNITO_CLIENT_ID,
      iss: `https://cognito-idp.us-west-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
      scope: "aws.cognito.signin.user.admin",
    } } },
    body: null, isBase64Encoded: false,
  };
}

function fixture(options: { missing?: boolean; payments?: boolean; guestFailure?: boolean; sqlFailure?: boolean; crossEventTask?: boolean;
  displayName?: string; ownerDisplayName?: string } = {}) {
  const calls: { operation: string; values: unknown[] }[] = [];
  const call = (operation: string, ...values: unknown[]) => { calls.push({ operation, values }); };
  const current = (sub: string) => options.missing ? undefined : {
    ...record, role: sub === "owner" ? "OWNER" as const : sub === "co" ? "CO_PLANNER" as const : null,
  };
  const repository: Pick<EventRepository, "create" | "list" | "getById" | "update" | "delete" | "listMembers" | "removeMember"> = {
    async list(sub) { call("list", sub); return [{ ...record, role: "OWNER" }]; },
    async listMembers(eventId, sub) {
      call("list-members", eventId, sub);
      return eventId === id && memberRows.some(member => member.cognito_sub === sub)
        ? memberRows.map(member => ({ ...member, display_name: (member.role === "OWNER" ? options.ownerDisplayName : options.displayName) ?? null }))
        : [];
    },
    async removeMember(eventId, memberId, sub) {
      call("remove-member", eventId, memberId, sub);
      if (eventId !== id || current(sub)?.role !== "OWNER") throw new MemberRemovalBlockedError("forbidden");
      const member = memberRows.find(row => row.member_id === memberId);
      if (!member) throw new MemberRemovalBlockedError("missing");
      if (member.role === "OWNER") throw new MemberRemovalBlockedError("owner");
      if (options.crossEventTask) throw new MemberRemovalBlockedError("cross-event-task");
      if (options.sqlFailure) throw new Error("private SQL detail");
    },
    async create(input, sub, displayName) { call("create", input, sub, displayName); return { ...record, ...input }; },
    async getById(eventId, sub) { call("get", eventId, sub); return current(sub); },
    async update(eventId, patch, sub, authorize) {
      call("update", eventId, patch, sub); const value = current(sub); authorize(value);
      return { ...value!, ...patch };
    },
    async delete(eventId, sub, authorize) {
      call("authorize-delete", eventId, sub); authorize(current(sub));
      if (options.payments) throw new EventDeletionBlockedError("payments");
      if (options.sqlFailure) throw new Error("private SQL detail");
      call("sql-commit", eventId);
    },
  };
  const service = new EventService(repository, () => "2026-11-15", {
    async deleteAllForEvent(eventId) {
      call("guests", eventId);
      if (options.guestFailure) throw new Error("guest cleanup failed");
      return 30;
    },
  });
  return { calls, service, handler: createEventsHandler({ service, env }) };
}

test("REST v1 list/detail/create/PATCH/DELETE reuse existing formats and exact IDs", async () => {
  const f = fixture();
  const list = await f.handler(proxy());
  assert.equal(list.statusCode, 200);
  assert.deepEqual(JSON.parse(list.body), [wire({ ...record, role: "OWNER" })]);
  assert.equal(list.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(list.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  assert.equal(list.isBase64Encoded, false);
  const detail = await f.handler(proxy("GET", `/events/${id}`));
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(JSON.parse(detail.body), wire({ ...record, role: "OWNER" }));
  const create = proxy("POST");
  create.body = JSON.stringify({ name: " New event ", template_id: "2", total_budget: "100.01" });
  const created = await f.handler(create);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(JSON.parse(created.body), wire({ ...record, name: "New event", total_budget: "100.01" }));
  assert.ok(!("role" in JSON.parse(created.body)));
  const patch = proxy("PATCH", `/events/${id}`);
  patch.body = JSON.stringify({ venue: "Hall" });
  const updated = await f.handler(patch);
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(JSON.parse(updated.body), wire({ ...record, venue: "Hall", role: "OWNER" }));
  const deleted = await f.handler(proxy("DELETE", `/events/${id}`));
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  assert.deepEqual(f.calls.slice(-2), [
    { operation: "sql-commit", values: [id] }, { operation: "guests", values: [id] },
  ]);
  assert.deepEqual(f.calls.find(c => c.operation === "get")?.values, [id, "owner"]);
});

const routes = [["GET", "/events"], ["POST", "/events"], ["GET", `/events/${id}`],
  ["PATCH", `/events/${id}`], ["DELETE", `/events/${id}`], ["GET", membersPath]] as const;

test("all six routes reject absent/untrusted identity without invoking services", async () => {
  for (const [method, path] of routes) {
    for (const context of [undefined, {}, { authorizer: { claims: {} } }, { authorizer: { sub: "owner", principalId: "owner" } }]) {
      const f = fixture();
      const event = proxy(method, path);
      event.requestContext = context;
      event.body = '{"userId":"owner","cognito_sub":"owner"}';
      event.headers = { Authorization: `Bearer ${Buffer.from('{"sub":"owner"}').toString("base64")}`, "x-user-id": "owner" };
      const result = await f.handler(event);
      assert.equal(result.statusCode, 401, `${method} ${path}`);
      assert.deepEqual(JSON.parse(result.body), { error: "Invalid or expired authentication token" });
      assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
      assert.deepEqual(f.calls, []);
    }
  }
});

test("members route returns a private roster with the verified caller marked for either role", async () => {
  const f = fixture({ displayName: "Maya Bennett", ownerDisplayName: "Wynn Le" });
  for (const sub of ["owner", "co"]) {
    const event = proxy("GET", membersPath, sub);
    event.body = '{"cognito_sub":"unrelated","eventId":"1"}';
    const result = await f.handler(event);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.deepEqual(JSON.parse(result.body), [
      { member_id: id, role: "OWNER", joined_at: "2026-11-21T10:00:00.000Z", is_self: sub === "owner", displayName: "Wynn Le" },
      { member_id: "2", role: "CO_PLANNER", joined_at: "2026-11-21T11:00:00.000Z", is_self: sub === "co", displayName: "Maya Bennett" },
    ]);
  }
  assert.deepEqual(f.calls.map(call => call.values), [[id, "owner"], [id, "co"]]);
});

test("members route denies unrelated callers and access to another or missing event", async () => {
  const f = fixture();
  for (const [path, sub] of [[membersPath, "unrelated"], ["/events/1/members", "co"], ["/events/2/members", "owner"]]) {
    const result = await f.handler(proxy("GET", path, sub));
    assert.equal(result.statusCode, 403);
    assert.deepEqual(JSON.parse(result.body), { error: "You do not have access to this event" });
  }
});

test("members route uses the co-planner label for an existing row with no stored display name", async () => {
  const f = fixture();
  const result = await f.handler(proxy("GET", membersPath));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body)[0].displayName, "Owner");
  assert.equal(JSON.parse(result.body)[1].displayName, "Co-planner");
});

test("event creation accepts a name only from the scoped profile authorizer context", async () => {
  const f = fixture();
  const event = proxy("POST");
  event.body = '{"name":"New event"}';
  event.headers = { ...event.headers, eventOwnerDisplayName: "Untrusted" };
  const trustedContext = {
    accountId: "123456789012", apiId: "hd63bpgxm8", stage: "prod",
    authorizer: { eventCreationAuthVersion: "1", principalId: "owner", eventCreationSub: "owner", eventOwnerDisplayName: "Wynn Le" },
  };
  assert.equal((await f.handler({ ...event, requestContext: trustedContext })).statusCode, 201);
  assert.equal((await f.handler(event)).statusCode, 201);
  assert.equal((await f.handler({ ...event, requestContext: { ...trustedContext, authorizer: {
    ...trustedContext.authorizer, eventOwnerDisplayName: undefined,
  } } })).statusCode, 201);
  assert.equal((await f.handler({ ...event, requestContext: { ...trustedContext, stage: "dev" } })).statusCode, 401);
  assert.equal((await f.handler({ ...event, requestContext: { ...trustedContext, authorizer: {
    ...trustedContext.authorizer, eventCreationSub: "someone-else",
  } } })).statusCode, 401);
  assert.equal((await f.handler({ ...event, body: '{"name":"New event","ownerDisplayName":"Untrusted"}', requestContext: trustedContext })).statusCode, 400);
  assert.deepEqual(f.calls.map(call => call.values.slice(1)), [["owner", "Wynn Le"], ["owner", null], ["owner", null]]);
});

test("member DELETE uses the verified owner, preserves exact string IDs, and returns empty 204", async () => {
  const f = fixture();
  const result = await f.handler(proxy("DELETE", `${membersPath}/0002`));
  assert.equal(result.statusCode, 204);
  assert.equal(result.body, "");
  assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  assert.deepEqual(f.calls, [{ operation: "remove-member", values: [id, "2", "owner"] }]);
});

test("member DELETE rejects unauthorized callers, the owner target, cross-event IDs and task references", async () => {
  const f = fixture();
  for (const sub of ["co", "unrelated"]) {
    for (const memberId of ["2", id]) {
      const event = proxy("DELETE", `${membersPath}/${memberId}`, sub);
      event.body = '{"role":"OWNER","cognito_sub":"owner"}';
      assert.equal((await f.handler(event)).statusCode, 403);
    }
  }
  assert.equal((await fixture({ missing: true }).handler(proxy("DELETE", memberItemPath))).statusCode, 403);
  const owner = await f.handler(proxy("DELETE", `${membersPath}/${id}`));
  assert.equal(owner.statusCode, 409);
  assert.deepEqual(JSON.parse(owner.body), { error: "The event owner cannot be removed" });
  assert.equal((await f.handler(proxy("DELETE", `${membersPath}/3`))).statusCode, 404);
  const tasks = await fixture({ crossEventTask: true }).handler(proxy("DELETE", memberItemPath));
  assert.equal(tasks.statusCode, 409);
  assert.match(JSON.parse(tasks.body).error, /task in another event/);
});

test("member DELETE validates authentication, IDs and Gateway route metadata before SQL", async () => {
  const f = fixture();
  const request = proxy("DELETE", memberItemPath);
  const invalid = proxy("DELETE", memberItemPath);
  invalid.requestContext!.authorizer!.claims!.token_use = "id";
  for (const event of [{ ...request, requestContext: undefined }, invalid]) {
    assert.equal((await f.handler(event)).statusCode, 401);
  }
  for (const path of [`${membersPath}/abc`, `${membersPath}/18446744073709551616`, "/events/0/members/2"]) {
    assert.equal((await f.handler(proxy("DELETE", path))).statusCode, 400);
  }
  for (const event of [
    { ...request, httpMethod: "GET" },
    { ...request, path: memberItemPath + "/" },
    { ...request, resource: "/events/{eventId}/members" },
    { ...request, pathParameters: { eventId: id, memberId: "3" } },
    { ...request, pathParameters: { eventId: "1", memberId: "2" } },
    { ...request, pathParameters: { eventId: id } },
    { ...request, pathParameters: { eventId: id, memberId: "2", invitationId: "2" } },
  ]) {
    assert.equal((await f.handler(event)).statusCode, 404);
  }
  const preflight = await f.handler({ ...request, httpMethod: "OPTIONS", requestContext: undefined });
  assert.equal(preflight.statusCode, 204);
  assert.deepEqual(f.calls, []);
});

test("member DELETE returns a generic database error", async t => {
  t.mock.method(console, "error", () => {});
  const response = await fixture({ sqlFailure: true }).handler(proxy("DELETE", memberItemPath));
  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: "Unable to remove event member" });
});

test("authorizer must supply access-token claims for the configured pool and client", async () => {
  for (const changes of [{ sub: "" }, { sub: " " }, { sub: "a".repeat(129) }, { sub: 123 },
    { token_use: "id" }, { token_use: undefined }, { client_id: "other" }, { iss: "https://untrusted.example" }]) {
    const f = fixture(); const event = proxy();
    Object.assign(event.requestContext!.authorizer!.claims!, changes);
    assert.equal((await f.handler(event)).statusCode, 401);
    assert.deepEqual(f.calls, []);
  }
  for (const missing of ["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"] as const) {
    const f = fixture();
    assert.equal((await createEventsHandler({ service: f.service, env: { ...env, [missing]: "" } })(proxy())).statusCode, 401);
    assert.deepEqual(f.calls, []);
  }
  // Only Gateway claims carry identity. The client header is neither required nor decoded here.
  const f = fixture(); const event = proxy(); event.headers = {};
  assert.equal((await f.handler(event)).statusCode, 200);
  assert.deepEqual(f.calls[0].values, ["owner"]);
});

test("real service enforces membership, OWNER-only writes and missing-event responses", async () => {
  for (const method of ["GET", "PATCH", "DELETE"]) {
    const f = fixture(); const event = proxy(method, `/events/${id}`, "unrelated");
    event.body = '{"name":"Changed"}';
    assert.equal((await f.handler(event)).statusCode, 403);
    assert.ok(!f.calls.some(c => c.operation === "sql-commit" || c.operation === "guests"));
    const absent = fixture({ missing: true });
    assert.equal((await absent.handler(event)).statusCode, 404);
    assert.ok(!absent.calls.some(c => c.operation === "guests"));
  }
  const f = fixture();
  assert.equal((await f.handler(proxy("GET", `/events/${id}`, "co"))).statusCode, 200);
  for (const method of ["PATCH", "DELETE"]) {
    const event = proxy(method, `/events/${id}`, "co"); event.body = '{"name":"Changed"}';
    assert.equal((await f.handler(event)).statusCode, 403);
  }
});

test("body validation preserves media type, JSON, decoded byte limits and unknown-field errors", async () => {
  for (const method of ["POST", "PATCH"]) {
    const path = method === "POST" ? "/events" : `/events/${id}`;
    const cases: [string | null, string, number, string][] = [
      ["text/plain", "{}", 415, "Content-Type must be application/json"],
      ["application/json", "{bad", 400, "Body must be valid JSON"],
      ["application/json", "", 400, "Body must be valid JSON"],
      ["application/json", "x".repeat(65_537), 413, "Request body is too large"],
      ["application/json", '{"name":"X","userId":"owner"}', 400, "Unsupported event property"],
      ["application/json", '{"name":"X","event_date":"2020-01-01"}', 400, "Event date cannot be in the past."],
    ];
    for (const [contentType, body, status, message] of cases) {
      const f = fixture(); const event = proxy(method, path);
      event.headers = contentType ? { "CONTENT-TYPE": contentType } : {};
      event.body = Buffer.from(body).toString("base64"); event.isBase64Encoded = true;
      const result = await f.handler(event);
      assert.equal(result.statusCode, status);
      assert.deepEqual(JSON.parse(result.body), { error: message });
      assert.deepEqual(f.calls, []);
    }
  }
  const f = fixture(); const event = proxy("POST");
  event.headers = { "Content-Type": "text/plain" };
  event.multiValueHeaders = { "content-type": ["application/json; charset=utf-8"] };
  event.body = Buffer.from('{"name":"婚礼 🎉"}').toString("base64"); event.isBase64Encoded = true;
  const result = await f.handler(event);
  assert.equal(result.statusCode, 201);
  assert.equal(JSON.parse(result.body).name, "婚礼 🎉");
  event.multiValueHeaders = { "Content-Type": ["application/json", "text/plain"] };
  assert.equal((await f.handler(event)).statusCode, 415);
});

test("invalid event IDs and empty PATCH retain existing validation", async () => {
  for (const value of ["abc", "0", "18446744073709551616"]) {
    const members = fixture();
    assert.equal((await members.handler(proxy("GET", `/events/${value}/members`))).statusCode, 400);
    assert.deepEqual(members.calls, []);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const f = fixture(); const event = proxy(method, `/events/${value}`); event.body = '{"name":"X"}';
      assert.equal((await f.handler(event)).statusCode, 400);
      assert.deepEqual(f.calls, []);
    }
  }
  const f = fixture(); const patch = proxy("PATCH", `/events/${id}`); patch.body = "{}";
  assert.equal((await f.handler(patch)).statusCode, 400);
  const leadingZeros = await f.handler(proxy("GET", "/events/0001"));
  assert.equal(leadingZeros.statusCode, 200);
  assert.deepEqual(f.calls.at(-1)?.values, ["1", "owner"]);
});

test("deletion conflicts and SQL failure prevent guest cleanup; guest failure retains 204", async t => {
  t.mock.method(console, "error", () => {});
  for (const [options, status] of [[{ payments: true }, 409], [{ sqlFailure: true }, 500]] as const) {
    const f = fixture(options); const result = await f.handler(proxy("DELETE", `/events/${id}`));
    assert.equal(result.statusCode, status);
    assert.ok(!result.body.includes("private SQL"));
    assert.ok(!f.calls.some(c => c.operation === "guests"));
  }
  const f = fixture({ guestFailure: true });
  const result = await f.handler(proxy("DELETE", `/events/${id}`));
  assert.equal(result.statusCode, 204); assert.equal(result.body, "");
  assert.deepEqual(f.calls.map(c => c.operation), ["authorize-delete", "sql-commit", "guests"]);
});

test("all six handler-specific internal errors remain generic JSON with CORS", async t => {
  t.mock.method(console, "error", () => {});
  const methods = ["list", "create", "getById", "update", "delete", "listMembers"] as const;
  const messages = ["list events", "create event", "retrieve event", "update event", "delete event", "list event members"];
  for (const [index, [method, path]] of routes.entries()) {
    const f = fixture(); const event = proxy(method, path); event.body = '{"name":"X"}';
    const service: EventsService = f.service;
    service[methods[index]] = async () => { throw new Error("private secret or SQL"); };
    const result = await createEventsHandler({ service, env })(event);
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), { error: `Unable to ${messages[index]}` });
    assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  }
});

test("exact route dispatch leaves guests, nested APIs, trailing slashes and unknown methods unhandled", async () => {
  const f = fixture();
  for (const [method, path] of [["GET", "/guest"], ["GET", "/events/"], ["GET", "/stage/events"],
    ["GET", "/events/1/guests"], ["GET", "/events/1/budget"], ["PUT", "/events"], ["POST", "/events/1"],
    ["GET", "/events//members"], ["GET", "/events/1/members/"], ["GET", "/events/1/members/2"],
    ["POST", membersPath], ["PATCH", membersPath], ["DELETE", membersPath]]) {
    assert.equal((await f.handler(proxy(method, path))).statusCode, 404);
  }
  const mismatched = proxy("GET", "/events/1"); mismatched.pathParameters = { eventId: "2" };
  assert.equal((await f.handler(mismatched)).statusCode, 404);
  const wrongResource = proxy(); wrongResource.resource = "/{proxy+}";
  assert.equal((await f.handler(wrongResource)).statusCode, 404);
  const memberWrongResource = proxy("GET", membersPath); memberWrongResource.resource = "/events/{eventId}";
  assert.equal((await f.handler(memberWrongResource)).statusCode, 404);
  for (const parameters of [{ eventId: "1" }, { id }]) {
    const memberWrongParameters = proxy("GET", membersPath); memberWrongParameters.pathParameters = parameters;
    assert.equal((await f.handler(memberWrongParameters)).statusCode, 404);
  }
  assert.deepEqual(f.calls, []);
});

test("OPTIONS is unauthenticated, empty and independent of DB/auth configuration", async () => {
  for (const path of ["/events", "/events/1", membersPath]) {
    const event = proxy("OPTIONS", path); event.requestContext = undefined;
    const result = await createEventsHandler({ env: { EVENTS_CORS_ORIGIN: env.EVENTS_CORS_ORIGIN } })(event);
    assert.equal(result.statusCode, 204); assert.equal(result.body, "");
    assert.equal(result.headers["Access-Control-Allow-Headers"], "Content-Type,Authorization");
  }
  const result = await createEventsHandler({ service: fixture().service, env: { ...env, EVENTS_CORS_ORIGIN: "" } })(proxy());
  assert.equal(result.headers["Access-Control-Allow-Origin"], undefined);
});

test("production handler fails closed without secret mode or with a local DynamoDB override", async t => {
  t.mock.method(console, "error", () => {});
  const aws = { ...env, DB_SECRET_ARN: "arn:test", DB_HOST: "rds.example", DB_NAME: "eventwise" };
  for (const bad of [{ DB_SECRET_ARN: "" }, { DB_HOST: "" }, { DB_NAME: "" }, { DYNAMODB_ENDPOINT: "http://localhost:8000" }]) {
    const result = await createEventsHandler({ env: { ...aws, ...bad } })(proxy());
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), { error: "Internal server error" });
  }
});

test("warm concurrent invocations keep authorizer identities and responses isolated", async () => {
  const f = fixture();
  f.service.list = async sub => {
    await new Promise(resolve => setTimeout(resolve, sub === "first" ? 15 : 1));
    return [{ ...record, name: sub, role: "OWNER" }];
  };
  const [first, second] = await Promise.all([f.handler(proxy("GET", "/events", "first")), f.handler(proxy("GET", "/events", "second"))]);
  assert.equal(JSON.parse(first.body)[0].name, "first");
  assert.equal(JSON.parse(second.body)[0].name, "second");
});
