import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { createAppServer } from "../server";
import type { UpdateEventDependencies } from "../event-service/handlers/updateEventHandler";
import { EventRepository, type EventWithMembership } from "../event-service/repositories/eventRepository";
import { EventService, validateEventPatch } from "../event-service/services/eventService";

const event: EventWithMembership = {
  event_id: "9007199254740993", name: "Wedding", template_id: null, event_date: "2028-02-29",
  venue: "Garden", total_budget: "123.45", role: "OWNER",
  created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
};

function fixture(options: { role?: EventWithMembership["role"]; missing?: boolean; templateMissing?: boolean; failure?: "update" | "commit" } = {}) {
  const calls: string[] = [];
  const queries: { sql: string; values?: unknown[] }[] = [];
  const current = { ...event, role: options.role === undefined ? "OWNER" as const : options.role };
  const updated = { ...current, name: "Updated", venue: null };
  const connection = {
    beginTransaction: async () => { calls.push("begin"); },
    execute: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("FROM event_templates")) { calls.push("template"); return [options.templateMissing ? [] : [{ template_id: 1 }]]; }
      if (sql.startsWith("UPDATE events")) {
        calls.push("update");
        if (options.failure === "update") throw new Error("private update details");
        return [{}];
      }
      if (sql.includes("FROM events")) {
        const locked = sql.endsWith("FOR UPDATE");
        calls.push(locked ? "lock" : "read");
        return [options.missing ? [] : [locked ? current : updated]];
      }
      assert.fail(`Unexpected query: ${sql}`);
    },
    commit: async () => { calls.push("commit"); if (options.failure === "commit") throw new Error("private commit details"); },
    rollback: async () => { calls.push("rollback"); },
    release: () => { calls.push("release"); },
  } as unknown as PoolConnection;
  return { service: new EventService(new EventRepository({ getConnection: async () => connection })), calls, queries, updated };
}

async function withServer(dependencies: Partial<UpdateEventDependencies>, run: (url: string) => Promise<void>) {
  const server = createAppServer({}, {}, {}, dependencies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function patch(url: string, body: unknown, authorization = "Bearer verified-token") {
  return fetch(url, { method: "PATCH", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("OWNER can partially update an event, using a transaction and the verified identity", async () => {
  const f = fixture();
  await withServer({ verifyToken: async (token) => { assert.equal(token, "verified-token"); return "owner-sub"; }, service: f.service }, async (url) => {
    const response = await patch(`${url}/${event.event_id}?cognito_sub=someone-else`, { name: "Updated", venue: null });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(f.updated)));
  });
  assert.deepEqual(f.calls, ["begin", "lock", "update", "read", "commit", "release"]);
  assert.deepEqual(f.queries[0].values, ["owner-sub", event.event_id]);
  assert.match(f.queries[0].sql, /m.cognito_sub = \?/);
  const update = f.queries.find((query) => query.sql.startsWith("UPDATE"))!;
  assert.equal(update.sql, "UPDATE events SET name = ?, venue = ? WHERE event_id = ?");
  assert.deepEqual(update.values, ["Updated", null, event.event_id]);
});

test("CO_PLANNER and unrelated users cannot update existing events", async () => {
  for (const role of ["CO_PLANNER", null] as const) {
    const f = fixture({ role });
    await withServer({ verifyToken: async () => "not-owner", service: f.service }, async (url) => {
      const response = await patch(`${url}/${event.event_id}`, { name: "Updated" });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Only the event owner can update this event" });
    });
    assert.deepEqual(f.calls, ["begin", "lock", "rollback", "release"]);
  }
});

test("missing events return 404 without executing an update", async () => {
  const f = fixture({ missing: true });
  await withServer({ verifyToken: async () => "owner", service: f.service }, async (url) => {
    assert.equal((await patch(`${url}/1`, { name: "Updated" })).status, 404);
  });
  assert.deepEqual(f.calls, ["begin", "lock", "rollback", "release"]);
});

test("PATCH validates only supplied fields and preserves omitted fields", () => {
  assert.deepEqual(validateEventPatch({ venue: null }), { venue: null });
  assert.deepEqual(validateEventPatch({ template_id: null, event_date: null, total_budget: 0 }), { template_id: null, event_date: null, total_budget: "0" });
  assert.deepEqual(validateEventPatch({ template_id: 1, name: " Updated " }), { template_id: "1", name: "Updated" });
  assert.deepEqual(validateEventPatch({ name: String.fromCodePoint(0x1f389).repeat(150), venue: "x".repeat(255), total_budget: "9999999999.99", event_date: "2028-02-29" }).event_date, "2028-02-29");
});

test("empty, invalid, unknown, identity, ownership and timestamp fields return 400", async () => {
  const invalid = [null, [], {}, "text", { name: null }, { name: " " }, { name: "x".repeat(151) },
    { venue: "x".repeat(256) }, { venue: 1 }, { template_id: 0 }, { template_id: 1.5 }, { template_id: "18446744073709551616" },
    { event_date: "2027-02-29" }, { event_date: "2028-04-31" }, { event_date: "0999-01-01" }, { event_date: "2028-01-01T00:00:00Z" },
    { total_budget: null }, { total_budget: -1 }, { total_budget: "0.001" }, { total_budget: "10000000000" },
    { event_id: "2" }, { cognito_sub: "attacker" }, { role: "OWNER" }, { owner: "attacker" }, { member_id: 1 }, { created_at: "2028-01-01" }, { updated_at: "2028-01-01" }, { unexpected: 1 },
    JSON.parse('{"__proto__":{"role":"OWNER"}}')];
  const service = new EventService({ create: async () => { assert.fail(); }, update: async () => { assert.fail("Database must not run"); } });
  await withServer({ verifyToken: async () => "owner", service }, async (url) => {
    for (const body of invalid) assert.equal((await patch(`${url}/1`, body)).status, 400, JSON.stringify(body));
    assert.equal((await fetch(`${url}/1`, { method: "PATCH", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await fetch(`${url}/1`, { method: "PATCH", headers: { authorization: "Bearer token", "content-type": "application/json" } })).status, 400);
  });
});

test("invalid event IDs return 400, while the unsigned BIGINT maximum is bound exactly", async () => {
  const f = fixture();
  await withServer({ verifyToken: async () => "owner", service: f.service }, async (url) => {
    for (const id of ["0", "-1", "1.5", "abc", "1e3", "18446744073709551616"]) {
      assert.equal((await patch(`${url}/${id}`, { name: "Updated" })).status, 400);
    }
    assert.equal((await patch(`${url}/18446744073709551615`, { name: "Updated" })).status, 200);
  });
  assert.deepEqual(f.queries[0].values, ["owner", "18446744073709551615"]);
});

test("missing/malformed tokens and invalid or expired JWTs return 401", async () => {
  const service = { update: async () => { assert.fail("Service must not run"); } };
  await withServer({ service }, async (url) => {
    for (const authorization of ["", "Basic token", "Bearer ", "Bearer a b", "Bearer invalid.jwt.token"]) {
      assert.equal((await patch(`${url}/1`, { name: "Updated" }, authorization)).status, 401);
    }
    assert.equal((await fetch(`${url}/1`, { method: "PATCH" })).status, 401);
  });
  await withServer({ verifyToken: async () => { throw new Error("Expired JWT"); }, service }, async (url) => {
    assert.equal((await patch(`${url}/1`, { name: "Updated" })).status, 401);
  });
});

test("nonexistent templates return 400 and roll back before writing", async () => {
  const f = fixture({ templateMissing: true });
  await withServer({ verifyToken: async () => "owner", service: f.service }, async (url) => {
    assert.equal((await patch(`${url}/1`, { template_id: 123 })).status, 400);
  });
  assert.deepEqual(f.calls, ["begin", "lock", "template", "rollback", "release"]);
  assert.deepEqual(f.queries[1].values, ["123"]);
  assert.match(f.queries[1].sql, /FOR SHARE/);
});

test("supported column names are fixed, and SQL-looking values are bound", async () => {
  const f = fixture();
  const name = "Robert'); DROP TABLE events; --";
  await f.service.update("1", { name, template_id: "1" }, "owner");
  assert.deepEqual(f.calls, ["begin", "lock", "template", "update", "read", "commit", "release"]);
  const update = f.queries.find((query) => query.sql.startsWith("UPDATE"))!;
  assert.equal(update.sql, "UPDATE events SET name = ?, template_id = ? WHERE event_id = ?");
  assert.deepEqual(update.values, [name, "1", "1"]);
  assert.ok(!update.sql.includes(name));
});

test("update and commit failures roll back, release, and return a generic 500", async () => {
  for (const failure of ["update", "commit"] as const) {
    const f = fixture({ failure });
    await withServer({ verifyToken: async () => "owner", service: f.service }, async (url) => {
      const response = await patch(`${url}/1`, { name: "Updated" });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to update event" });
    });
    assert.deepEqual(f.calls.slice(-2), ["rollback", "release"]);
  }
});
