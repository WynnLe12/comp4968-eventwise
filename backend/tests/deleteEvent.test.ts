import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { createAppServer } from "../server";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { EventService } from "../event-service/services/eventService";
import type { DeleteEventDependencies } from "../event-service/handlers/deleteEventHandler";

function fixture(options: { role?: "OWNER" | "CO_PLANNER" | null; missing?: boolean; payments?: boolean; crossTask?: boolean; crossDraft?: boolean; failure?: "expenses" | "event" | "commit"; guestFailure?: boolean } = {}) {
  const calls: string[] = [], queries: { sql: string; values?: unknown[] }[] = [];
  const connection = {
    beginTransaction: async () => { calls.push("begin"); },
    execute: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("FROM events e")) return [options.missing ? [] : [{ role: options.role === undefined ? "OWNER" : options.role }]];
      if (sql.includes("FROM expense_payments")) return [options.payments ? [{ payment_id: "1" }] : []];
      if (sql.includes("FROM tasks t")) return [options.crossTask ? [{ task_id: "1" }] : []];
      if (sql.includes("FROM draft_budget_items b")) return [options.crossDraft ? [{ draft_id: "1" }] : []];
      if (sql.startsWith("SELECT")) return [[]];
      if (sql.startsWith("DELETE FROM expenses")) { calls.push("expenses"); if (options.failure === "expenses") throw new Error("private SQL"); return [{ affectedRows: 1 }]; }
      if (sql.startsWith("DELETE FROM events")) { calls.push("event"); if (options.failure === "event") throw new Error("private SQL"); return [{ affectedRows: 1 }]; }
      assert.fail(`Unexpected query: ${sql}`);
    },
    commit: async () => { calls.push("commit"); if (options.failure === "commit") throw new Error("private SQL"); },
    rollback: async () => { calls.push("rollback"); }, release: () => { calls.push("release"); },
  } as unknown as PoolConnection;
  const guests = { deleteAllForEvent: async (eventId: string) => {
    calls.push(`guests:${eventId}`);
    if (options.guestFailure) throw new Error("DynamoDB unavailable");
    return 0;
  } };
  return { service: new EventService(new EventRepository({ getConnection: async () => connection }), undefined, guests), calls, queries };
}
async function withServer(deps: Partial<DeleteEventDependencies>, run: (url: string) => Promise<void>) {
  const server = createAppServer({}, {}, {}, {}, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
const remove = (url: string, token = "Bearer verified") => fetch(url, { method: "DELETE", headers: { authorization: token } });

test("DELETE requires a verified access token and never accepts caller-supplied identity", async () => {
  const f = fixture();
  await withServer({ service: f.service, verifyToken: async (token) => { if (token !== "verified") throw new Error("Expired"); return "owner-sub"; } }, async (url) => {
    for (const token of ["", "Bearer", "Basic verified", "Bearer expired"]) assert.equal((await remove(`${url}/1`, token)).status, 401);
    assert.equal(f.queries.length, 0);
    assert.equal((await remove(`${url}/1?cognito_sub=attacker`)).status, 204);
    assert.deepEqual(f.queries[0].values, ["owner-sub", "1"]);
  });
});

test("OWNER deletion uses bound exact BIGINT IDs and removes expenses before cascading the event", async () => {
  const f = fixture();
  await withServer({ service: f.service, verifyToken: async () => "owner" }, async (url) => {
    const response = await remove(`${url}/18446744073709551615`);
    assert.equal(response.status, 204); assert.equal(await response.text(), "");
    for (const id of ["0", "-1", "1.5", "18446744073709551616", "1%20OR%201=1"]) assert.equal((await remove(`${url}/${id}`)).status, 400);
  });
  assert.deepEqual(f.calls, ["begin", "expenses", "event", "commit", "release", "guests:18446744073709551615"]);
  assert.match(f.queries[0].sql, /FOR UPDATE$/);
  for (const query of f.queries) assert.ok(query.values?.includes("18446744073709551615"));
  assert.ok(!f.queries.some(({ sql }) => /DELETE FROM (event_templates|template_budget_categories)/.test(sql)));
});

test("CO_PLANNER/unrelated users get 403; absent events get 404 before dependent writes", async () => {
  for (const options of [{ role: "CO_PLANNER" as const }, { role: null }, { missing: true }]) {
    const f = fixture(options);
    await withServer({ service: f.service, verifyToken: async () => "other" }, async (url) => {
      assert.equal((await remove(`${url}/1`)).status, "missing" in options ? 404 : 403);
    });
    assert.deepEqual(f.calls, ["begin", "rollback", "release"]);
    assert.equal(f.queries.length, 1);
  }
});

test("payment history and cross-event task/document references return safe 409 without deleting", async () => {
  for (const options of [{ payments: true }, { crossTask: true }, { crossDraft: true }]) {
    const f = fixture(options);
    await withServer({ service: f.service, verifyToken: async () => "owner" }, async (url) => {
      const response = await remove(`${url}/1`);
      assert.equal(response.status, 409);
      assert.match(JSON.stringify(await response.json()), /cannot be deleted/);
    });
    assert.deepEqual(f.calls, ["begin", "rollback", "release"]);
    assert.ok(!f.queries.some(({ sql }) => sql.startsWith("DELETE")));
  }
});

test("expense deletion, event deletion, and commit failures roll back and return generic 500", async () => {
  for (const failure of ["expenses", "event", "commit"] as const) {
    const f = fixture({ failure });
    await withServer({ service: f.service, verifyToken: async () => "owner" }, async (url) => {
      const response = await remove(`${url}/1`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Unable to delete event" });
    });
    assert.deepEqual(f.calls.slice(-2), ["rollback", "release"]);
  }
});

test("guest cleanup failure after the MySQL commit is logged and still returns 204", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const f = fixture({ guestFailure: true });
  await withServer({ service: f.service, verifyToken: async () => "owner" }, async (url) => {
    assert.equal((await remove(`${url}/7`)).status, 204);
  });
  assert.deepEqual(f.calls, ["begin", "expenses", "event", "commit", "release", "guests:7"]);
  assert.equal(logged.mock.callCount(), 1);
});
