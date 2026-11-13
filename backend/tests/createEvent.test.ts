import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { createAppServer } from "../server";
import type { CreateEventDependencies } from "../event-service/handlers/createEventHandler";
import { EventRepository, InvalidTemplateError, type EventInput, type EventRecord } from "../event-service/repositories/eventRepository";
import { EventService, EventValidationError, validateEventInput } from "../event-service/services/eventService";

const input: EventInput = {
  name: "Wedding", template_id: null, event_date: "2028-02-29", venue: "Garden", total_budget: "12500.50",
};
const event: EventRecord = {
  ...input, event_id: "42", created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
};

async function withServer(deps: Partial<CreateEventDependencies>, run: (url: string) => Promise<void>) {
  const server = createAppServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function post(url: string, body: unknown, authorization = "Bearer verified-token") {
  return fetch(url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("POST /events returns 201 and assigns only the verified user's identity", async () => {
  const service = new EventService({ create: async (values, sub) => {
    assert.deepEqual(values, input);
    assert.equal(sub, "verified-user-sub");
    return event;
  } });
  await withServer({ verifyToken: async (token) => {
    assert.equal(token, "verified-token");
    return "verified-user-sub";
  }, service }, async (url) => {
    const response = await post(url, input);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ...event, created_at: event.created_at.toISOString(), updated_at: event.updated_at.toISOString() });
  });
});

test("missing or malformed Bearer headers cannot reach verification or creation", async () => {
  await withServer({ verifyToken: async () => { assert.fail("Verifier must not run"); }, service: { create: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    for (const header of ["", "Basic token", "Bearer ", "Bearer a b"]) {
      assert.equal((await post(url, input, header)).status, 401);
    }
  });
});

test("the existing Cognito verifier rejects invalid JWTs", async () => {
  await withServer({ service: { create: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    assert.equal((await post(url, input, "Bearer invalid.jwt.token")).status, 401);
  });
});

test("verification failures including expired tokens return 401", async () => {
  await withServer({ verifyToken: async () => { throw new Error("JWT expired"); }, service: { create: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    assert.equal((await post(url, input)).status, 401);
  });
});

test("invalid inputs and body-supplied identity return 400 without database access", async () => {
  const invalid = [null, [], {}, { name: " " }, { name: "a".repeat(151) },
    { ...input, venue: "x".repeat(256) }, { ...input, venue: 2 },
    { ...input, total_budget: -1 }, { ...input, total_budget: null },
    { ...input, total_budget: "0.001" }, { ...input, total_budget: "10000000000" },
    { ...input, template_id: 1.5 }, { ...input, template_id: 0 },
    { ...input, template_id: "18446744073709551616" },
    { ...input, template_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, event_date: "2027-02-29" }, { ...input, event_date: "2026-04-31" },
    { ...input, event_date: "0999-01-01" }, { ...input, event_date: "2026-01-01T00:00:00Z" },
    { ...input, cognito_sub: "attacker" }, { ...input, role: "OWNER" }, { ...input, event_id: 1 }];
  await withServer({ verifyToken: async () => "user", service: new EventService({ create: async () => { assert.fail("Repository must not run"); } }) }, async (url) => {
    for (const body of invalid) assert.equal((await post(url, body)).status, 400, JSON.stringify(body));
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer valid", "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer valid" }, body: "{}" })).status, 415);
    assert.equal((await post(url, { name: "x".repeat(70_000) })).status, 413);
  });
});

test("schema defaults, nullable columns, unicode lengths, and exact decimals are supported", () => {
  assert.deepEqual(validateEventInput({ name: "  Birthday  " }), {
    name: "Birthday", template_id: null, event_date: null, venue: null, total_budget: "0.00",
  });
  assert.equal(validateEventInput({ name: String.fromCodePoint(0x1f389).repeat(150), total_budget: "9999999999.99", template_id: "18446744073709551615" }).total_budget, "9999999999.99");
  assert.equal(validateEventInput({ ...input, template_id: 1 }).template_id, "1");
});

function transaction(failure?: "event" | "member" | "commit", templateExists = true) {
  const calls: string[] = [];
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  const connection = {
    beginTransaction: async () => { calls.push("begin"); },
    execute: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("FROM event_templates")) return [templateExists ? [{ template_id: 1 }] : []];
      if (sql.startsWith("INSERT INTO events")) {
        calls.push("event");
        if (failure === "event") throw new Error("insert failed");
        return [{}];
      }
      if (sql.includes("FROM events")) { calls.push("read"); return [[event]]; }
      if (sql.startsWith("INSERT INTO event_members")) {
        calls.push("member");
        if (failure === "member") throw new Error("membership failed");
        return [{}];
      }
      assert.fail(`Unexpected query: ${sql}`);
    },
    commit: async () => { calls.push("commit"); if (failure === "commit") throw new Error("commit failed"); },
    rollback: async () => { calls.push("rollback"); },
    release: () => { calls.push("release"); },
  } as unknown as PoolConnection;
  return { repository: new EventRepository({ getConnection: async () => connection }), calls, queries };
}

test("event and OWNER inserts share one committed transaction with bound values", async () => {
  const fixture = transaction();
  const values = { ...input, template_id: "1", name: "Robert'); DROP TABLE events; --" };
  assert.equal(await fixture.repository.create(values, "owner-sub"), event);
  assert.deepEqual(fixture.calls, ["begin", "event", "read", "member", "commit", "release"]);
  assert.match(fixture.queries[0].sql, /FOR SHARE/);
  assert.deepEqual(fixture.queries[0].values, ["1"]);
  assert.deepEqual(fixture.queries[1].values, [values.name, "1", input.event_date, input.venue, input.total_budget]);
  assert.ok(!fixture.queries[1].sql.includes(values.name));
  assert.deepEqual(fixture.queries[3].values, [event.event_id, "owner-sub"]);
  assert.match(fixture.queries[3].sql, /'OWNER'/);
});

test("event insertion, membership insertion, and commit failures roll back and release", async () => {
  for (const failure of ["event", "member", "commit"] as const) {
    const fixture = transaction(failure);
    await assert.rejects(fixture.repository.create(input, "user"));
    assert.deepEqual(fixture.calls.slice(-2), ["rollback", "release"]);
    if (failure !== "commit") assert.ok(!fixture.calls.includes("commit"));
  }
});

test("nonexistent templates roll back and become input errors", async () => {
  const fixture = transaction(undefined, false);
  const service = new EventService(fixture.repository);
  await assert.rejects(service.create({ ...input, template_id: 1 }, "user"), EventValidationError);
  assert.deepEqual(fixture.calls, ["begin", "rollback", "release"]);
  await withServer({ verifyToken: async () => "user", service: new EventService({ create: async () => { throw new InvalidTemplateError("template_id does not exist"); } }) }, async (url) => {
    assert.equal((await post(url, { ...input, template_id: 1 })).status, 400);
  });
});

test("database failures return a generic 500 without leaking SQL details", async () => {
  await withServer({ verifyToken: async () => "user", service: { create: async () => { throw new Error("private database information"); } } }, async (url) => {
    const response = await post(url, input);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Unable to create event" });
  });
});
