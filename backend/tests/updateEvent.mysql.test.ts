import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { db } from "../shared/db/db";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { EventService, EventAccessDeniedError, EventNotFoundError, EventValidationError } from "../event-service/services/eventService";

const enabled = process.env.EVENTWISE_MYSQL_TEST === "1";
after(async () => { await db.end(); });

test("MySQL: only OWNER can partially update fields, clear nullable fields, and change templates", { skip: !enabled }, async () => {
  const repository = new EventRepository();
  const service = new EventService(repository);
  const owner = `update-owner-${randomUUID()}`;
  const coPlanner = `update-co-${randomUUID()}`;
  const event = await repository.create({ name: `update-test-${randomUUID()}`, template_id: null, event_date: "2028-02-29", venue: "Garden", total_budget: "123.45" }, owner);
  try {
    await db.execute("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'CO_PLANNER')", [event.event_id, coPlanner]);
    for (const sub of [coPlanner, `update-other-${randomUUID()}`]) {
      await assert.rejects(service.update(event.event_id, { name: "Denied" }, sub), EventAccessDeniedError);
    }
    assert.deepEqual(await service.getById(event.event_id, owner), { ...event, role: "OWNER" });
    const updated = await service.update(event.event_id, { name: "Updated" }, owner);
    assert.equal(updated.name, "Updated");
    assert.equal(updated.total_budget, event.total_budget);
    assert.equal(updated.event_date, event.event_date);
    assert.equal(updated.venue, event.venue);
    assert.deepEqual(updated.created_at, event.created_at);
    // A same-value patch is still successful even when MySQL reports no changed rows.
    assert.equal((await service.update(event.event_id, { name: "Updated" }, owner)).name, "Updated");
    const [templates] = await db.execute<RowDataPacket[]>("SELECT CAST(template_id AS CHAR) AS id FROM event_templates LIMIT 1");
    if (templates[0]) {
      assert.equal((await service.update(event.event_id, { template_id: String(templates[0].id) }, owner)).template_id, String(templates[0].id));
    }
    const cleared = await service.update(event.event_id, { template_id: null, event_date: null, venue: null, total_budget: "0.00" }, owner);
    assert.equal(cleared.template_id, null);
    assert.equal(cleared.event_date, null);
    assert.equal(cleared.venue, null);
    assert.equal(cleared.total_budget, "0.00");
    await assert.rejects(service.update(event.event_id, { name: "Must not persist", template_id: "18446744073709551615" }, owner), EventValidationError);
    assert.equal((await service.getById(event.event_id, owner)).name, "Updated");
  } finally {
    await db.execute("DELETE FROM events WHERE event_id = ?", [event.event_id]);
  }
  await assert.rejects(service.update(event.event_id, { name: "Missing" }, owner), EventNotFoundError);
});

test("MySQL: a failure after UPDATE rolls back all changed values", { skip: !enabled }, async () => {
  const owner = `update-rollback-${randomUUID()}`;
  const event = await new EventRepository().create({ name: `update-test-${randomUUID()}`, template_id: null, event_date: null, venue: null, total_budget: "123.45" }, owner);
  const repository = new EventRepository({ getConnection: async () => {
    const connection = await db.getConnection();
    return new Proxy(connection, {
      get(target, property) {
        if (property === "execute") return (sql: string, values?: (string | number | null)[]) => {
          if (sql.includes("FROM events") && !sql.endsWith("FOR UPDATE")) throw new Error("Injected read failure after update");
          return target.execute(sql, values);
        };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolConnection;
  } });
  try {
    await assert.rejects(new EventService(repository).update(event.event_id, { name: "Must roll back", total_budget: "500.00" }, owner));
    assert.deepEqual(await new EventService().getById(event.event_id, owner), { ...event, role: "OWNER" });
  } finally {
    await db.execute("DELETE FROM events WHERE event_id = ?", [event.event_id]);
  }
});
