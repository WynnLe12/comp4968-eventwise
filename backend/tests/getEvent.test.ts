import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { createAppServer } from "../server";
import type { GetEventDependencies } from "../event-service/handlers/getEventHandler";
import { EventRepository, type EventWithMembership } from "../event-service/repositories/eventRepository";
import { EventService, validateEventId } from "../event-service/services/eventService";

const event: EventWithMembership = {
  event_id: "9007199254740993", template_id: null, name: "Wedding", event_date: "2028-02-29",
  venue: "Garden", total_budget: "12500.50", role: "OWNER",
  created_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z"),
};

function serviceWith(getById: (id: string, sub: string) => Promise<EventWithMembership | undefined>) {
  return new EventService({ create: async () => { assert.fail("Create must not run"); }, getById });
}

async function withServer(dependencies: Partial<GetEventDependencies>, run: (url: string) => Promise<void>) {
  const server = createAppServer({}, {}, dependencies);
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

test("OWNER and CO_PLANNER can retrieve details using only their verified identity", async () => {
  for (const role of ["OWNER", "CO_PLANNER"] as const) {
    const service = serviceWith(async (id, sub) => {
      assert.equal(id, event.event_id);
      assert.equal(sub, "verified-user");
      return { ...event, role };
    });
    await withServer({ verifyToken: async (token) => { assert.equal(token, "verified-token"); return "verified-user"; }, service }, async (url) => {
      const response = await get(`${url}/${event.event_id}?cognito_sub=another-user`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await response.json(), JSON.parse(JSON.stringify({ ...event, role })));
    });
  }
});

test("an unrelated authenticated user receives 403 with no event details", async () => {
  const service = serviceWith(async (id, sub) => {
    assert.equal(id, event.event_id);
    assert.equal(sub, "unrelated-user");
    return { ...event, role: null };
  });
  await withServer({ verifyToken: async () => "unrelated-user", service }, async (url) => {
    const response = await get(`${url}/${event.event_id}?cognito_sub=owner`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "You do not have access to this event" });
  });
});

test("a nonexistent event returns 404", async () => {
  await withServer({ verifyToken: async () => "user", service: serviceWith(async () => undefined) }, async (url) => {
    const response = await get(`${url}/1`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Event not found" });
  });
});

test("invalid event IDs return 400 before database access", async () => {
  const invalidIds = ["0", "000", "-1", "+1", "1.5", "1e3", "abc", "18446744073709551616", "9".repeat(21), "1%20", "1%2F2", "1%27OR1=1"];
  await withServer({ verifyToken: async () => "user", service: serviceWith(async () => { assert.fail("Repository must not run"); }) }, async (url) => {
    for (const id of invalidIds) assert.equal((await get(`${url}/${id}`)).status, 400, id);
  });
  for (const id of [null, undefined, 1, "", " 1", "1 "]) assert.throws(() => validateEventId(id));
});

test("unsigned BIGINT maximum and leading zeros are handled without numeric coercion", async () => {
  const maximum = "18446744073709551615";
  assert.equal(validateEventId("0001"), "1");
  await withServer({ verifyToken: async () => "user", service: serviceWith(async (id) => {
    assert.equal(id, maximum);
    return { ...event, event_id: id };
  }) }, async (url) => {
    const response = await get(`${url}/${maximum}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { event_id: string }).event_id, maximum);
  });
});

test("missing or malformed Bearer headers return 401 before verification or database access", async () => {
  await withServer({ verifyToken: async () => { assert.fail("Verifier must not run"); }, service: { getById: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    assert.equal((await fetch(`${url}/1`)).status, 401);
    for (const authorization of ["", "Basic token", "Bearer ", "Bearer a b"]) {
      assert.equal((await fetch(`${url}/1`, { headers: { authorization } })).status, 401);
    }
  });
});

test("invalid JWTs are rejected by the existing Cognito verifier", async () => {
  await withServer({ service: { getById: async () => { assert.fail("Service must not run"); } } }, async (url) => {
    assert.equal((await get(`${url}/1`, "invalid.jwt.token")).status, 401);
  });
});

test("expired token failures and invalid subjects return 401", async () => {
  for (const verifyToken of [async () => { throw new Error("JWT expired"); }, async () => "", async () => "x".repeat(129)]) {
    await withServer({ verifyToken, service: { getById: async () => { assert.fail("Service must not run"); } } }, async (url) => {
      assert.equal((await get(`${url}/1`)).status, 401);
    });
  }
});

test("repository binds both identity and BIGINT ID, selects no other membership data, and releases", async () => {
  let released = false;
  const sub = "user' OR 1=1 --";
  const connection = {
    execute: async (sql: string, values: unknown[]) => {
      assert.match(sql, /LEFT JOIN event_members m ON m.event_id = e.event_id AND m.cognito_sub = \?/);
      assert.match(sql, /WHERE e.event_id = \?/);
      assert.deepEqual(values, [sub, event.event_id]);
      assert.ok(!sql.includes(sub));
      const selected = sql.split("FROM")[0];
      assert.match(selected, /m.role/);
      assert.doesNotMatch(selected, /cognito_sub|member_id|joined_at|owner_event_id|\*/);
      return [[event]];
    },
    release: () => { released = true; },
  } as unknown as PoolConnection;
  assert.deepEqual(await new EventRepository({ getConnection: async () => connection }).getById(event.event_id, sub), event);
  assert.ok(released);
});

test("database errors release the connection and return a generic HTTP 500", async () => {
  let released = false;
  const connection = {
    execute: async () => { throw new Error("private database details"); },
    release: () => { released = true; },
  } as unknown as PoolConnection;
  await withServer({ verifyToken: async () => "user", service: new EventService(new EventRepository({ getConnection: async () => connection })) }, async (url) => {
    const response = await get(`${url}/1`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Unable to retrieve event" });
  });
  assert.ok(released);
});
