import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { db } from "../shared/db/db";
import { EventRepository } from "../event-service/repositories/eventRepository";

const enabled = process.env.EVENTWISE_MYSQL_TEST === "1";
after(async () => { await db.end(); });

test("MySQL: membership filtering isolates users and includes their role on shared events", { skip: !enabled }, async () => {
  const repository = new EventRepository();
  const userA = `list-test-a-${randomUUID()}`;
  const userB = `list-test-b-${randomUUID()}`;
  const eventIds: string[] = [];
  async function create(name: string, sub: string, date: string | null) {
    const event = await repository.create({ name, event_date: date, template_id: null, venue: null, total_budget: "123.45" }, sub);
    eventIds.push(event.event_id);
    return event;
  }
  try {
    const onlyA = await create(`list-test-${randomUUID()}`, userA, "2028-02-29");
    const onlyB = await create(`list-test-${randomUUID()}`, userB, null);
    const shared = await create(`list-test-${randomUUID()}`, userB, "2027-01-01");
    await db.execute("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'CO_PLANNER')", [shared.event_id, userA]);
    const a = await repository.list(userA);
    const b = await repository.list(userB);
    assert.deepEqual(a.map((event) => [event.event_id, event.role]), [[shared.event_id, "CO_PLANNER"], [onlyA.event_id, "OWNER"]]);
    assert.deepEqual(b.map((event) => [event.event_id, event.role]), [[shared.event_id, "OWNER"], [onlyB.event_id, "OWNER"]]);
    assert.equal(a[0].event_date, "2027-01-01");
    assert.equal(a[0].total_budget, "123.45");
    assert.equal(b[1].event_date, null);
    assert.deepEqual(await repository.list(`list-test-none-${randomUUID()}`), []);
  } finally {
    for (const id of eventIds) await db.execute("DELETE FROM events WHERE event_id = ?", [id]);
  }
});
