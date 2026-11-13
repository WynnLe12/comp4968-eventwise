import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { createAppServer } from "../server";
import type { ListEventsDependencies } from "../event-service/handlers/listEventsHandler";
import { EventRepository, type ListedEvent } from "../event-service/repositories/eventRepository";
import { EventService } from "../event-service/services/eventService";

const owned: ListedEvent = {
  event_id: "42", template_id: null, name: "Wedding", event_date: "2028-02-29",
  venue: "Garden", total_budget: "12500.50", role: "OWNER",
  created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
};
const shared: ListedEvent = { ...owned, event_id: "43", role: "CO_PLANNER" };

async function withServer(dependencies: Partial<ListEventsDependencies>, run: (url: string) => Promise<void>) {
  const server = createAppServer({}, dependencies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function get(url: string, token = "verified-token") {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

test("GET /events returns a direct array with the authenticated membership roles", async () => {
  const service = new EventService({
    create: async () => { assert.fail("Create must not run"); },
    list: async (sub) => { assert.equal(sub, "user-a"); return [owned, shared]; },
  });
  await withServer({ verifyToken: async (token) => { assert.equal(token, "verified-token"); return "user-a"; }, service }, async (url) => {
    // An untrusted identity in query parameters must not affect the selected user.
    const response = await get(`${url}?cognito_sub=user-b`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify([owned, shared])));
  });
});

test("users with no memberships receive HTTP 200 and []", async () => {
  await withServer({ verifyToken: async () => "new-user", service: { list: async (sub) => { assert.equal(sub, "new-user"); return []; } } }, async (url) => {
    const response = await get(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
});

test("two users cannot select one another's event lists", async () => {
  const service = new EventService({
    create: async () => { assert.fail("Create must not run"); },
    list: async (sub) => sub === "user-a" ? [owned] : [shared],
  });
  await withServer({ verifyToken: async (token) => token === "token-a" ? "user-a" : "user-b", service }, async (url) => {
    const a = await get(`${url}?cognito_sub=user-b`, "token-a");
    const b = await get(`${url}?cognito_sub=user-a`, "token-b");
    assert.deepEqual(await a.json(), JSON.parse(JSON.stringify([owned])));
    assert.deepEqual(await b.json(), JSON.parse(JSON.stringify([shared])));
  });
});

test("missing and malformed authentication headers return 401 before service access", async () => {
  await withServer({ verifyToken: async () => { assert.fail("Verifier must not run"); }, service: { list: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    assert.equal((await fetch(url)).status, 401);
    for (const authorization of ["", "Basic token", "Bearer ", "Bearer a b"]) {
      assert.equal((await fetch(url, { headers: { authorization } })).status, 401);
    }
  });
});

test("invalid JWTs are rejected by the existing Cognito verifier", async () => {
  await withServer({ service: { list: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    assert.equal((await get(url, "invalid.jwt.token")).status, 401);
  });
});

test("expired token failures and invalid verified subjects cannot reach the service", async () => {
  for (const verifyToken of [async () => { throw new Error("Token expired"); }, async () => "", async () => "x".repeat(129)]) {
    await withServer({ verifyToken, service: { list: async () => { assert.fail("Service must not run"); } } }, async (url) => {
      assert.equal((await get(url)).status, 401);
    });
  }
});

test("repository binds the Cognito subject in the membership join and releases the connection", async () => {
  const sub = "user' OR 1=1 --";
  let released = false;
  const connection = {
    execute: async (sql: string, values: unknown[]) => {
      assert.match(sql, /INNER JOIN event_members m ON m.event_id = e.event_id/);
      assert.match(sql, /WHERE m.cognito_sub = \?/);
      assert.match(sql, /m.role/);
      assert.match(sql, /ORDER BY e.event_date IS NULL, e.event_date, e.event_id/);
      assert.ok(!sql.includes(sub));
      assert.deepEqual(values, [sub]);
      return [[owned, shared]];
    },
    release: () => { released = true; },
  } as unknown as PoolConnection;
  const repository = new EventRepository({ getConnection: async () => connection });
  assert.deepEqual(await repository.list(sub), [owned, shared]);
  assert.ok(released);
});

test("database query failures release the connection and return a generic HTTP 500", async () => {
  let released = false;
  const connection = {
    execute: async () => { throw new Error("private SQL details"); },
    release: () => { released = true; },
  } as unknown as PoolConnection;
  const service = new EventService(new EventRepository({ getConnection: async () => connection }));
  await withServer({ verifyToken: async () => "user-a", service }, async (url) => {
    const response = await get(url);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Unable to list events" });
  });
  assert.ok(released);
});
