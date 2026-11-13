import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { db } from "../shared/db/db";
import { EventRepository, type EventInput } from "../event-service/repositories/eventRepository";

const enabled = process.env.EVENTWISE_MYSQL_TEST === "1";
after(async () => { await db.end(); });

function input(): EventInput {
  return { name: `create-event-test-${randomUUID()}`, template_id: null, event_date: "2028-02-29", venue: "Test venue", total_budget: "123.45" };
}

test("MySQL: created event has its OWNER membership and exact date/budget", { skip: !enabled }, async () => {
  const values = input();
  const sub = `test-${randomUUID()}`;
  const [templates] = await db.execute<RowDataPacket[]>("SELECT CAST(template_id AS CHAR) AS id FROM event_templates LIMIT 1");
  if (templates[0]) values.template_id = String(templates[0].id);
  let eventId: string | undefined;
  try {
    const event = await new EventRepository().create(values, sub);
    eventId = event.event_id;
    assert.equal(event.event_date, values.event_date);
    assert.equal(event.total_budget, values.total_budget);
    assert.equal(event.template_id, values.template_id);
    const [members] = await db.execute<RowDataPacket[]>(
      "SELECT cognito_sub, role FROM event_members WHERE event_id = ?", [eventId],
    );
    assert.equal(members.length, 1);
    assert.equal(members[0].cognito_sub, sub);
    assert.equal(members[0].role, "OWNER");
  } finally {
    // Deletes only this test's event; the schema cascades its membership.
    if (eventId) await db.execute("DELETE FROM events WHERE event_id = ?", [eventId]);
  }
});

test("MySQL: a failed OWNER insert rolls back the already-inserted event", { skip: !enabled }, async () => {
  const values = input();
  let membershipAttempted = false;
  const repository = new EventRepository({ getConnection: async () => {
    const connection = await db.getConnection();
    // Inject a schema violation only into the OWNER insert on a real connection.
    return new Proxy(connection, {
      get(target, property) {
        if (property === "execute") return (sql: string, parameters?: (string | number | null)[]) => {
          if (sql.startsWith("INSERT INTO event_members")) {
            membershipAttempted = true;
            return target.execute(sql, [parameters?.[0] ?? null, null]);
          }
          return target.execute(sql, parameters);
        };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolConnection;
  } });
  await assert.rejects(repository.create(values, "test-owner"));
  assert.ok(membershipAttempted);
  const [events] = await db.execute<RowDataPacket[]>("SELECT event_id FROM events WHERE name = ?", [values.name]);
  assert.equal(events.length, 0);
});
