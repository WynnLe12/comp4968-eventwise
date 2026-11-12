import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { db } from "../shared/db/db";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { EventService, EventAccessDeniedError, EventNotFoundError } from "../event-service/services/eventService";

const enabled = process.env.EVENTWISE_MYSQL_TEST === "1";
after(async () => { await db.end(); });

test("MySQL: event details allow only OWNER/CO_PLANNER and distinguish 403 from 404", { skip: !enabled }, async () => {
  const repository = new EventRepository();
  const service = new EventService(repository);
  const owner = `detail-owner-${randomUUID()}`;
  const coPlanner = `detail-co-${randomUUID()}`;
  const stranger = `detail-other-${randomUUID()}`;
  const event = await repository.create({ name: `detail-test-${randomUUID()}`, template_id: null, event_date: "2028-02-29", venue: null, total_budget: "123.45" }, owner);
  try {
    await db.execute("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'CO_PLANNER')", [event.event_id, coPlanner]);
    assert.deepEqual(await service.getById(event.event_id, owner), { ...event, role: "OWNER" });
    assert.deepEqual(await service.getById(event.event_id, coPlanner), { ...event, role: "CO_PLANNER" });
    await assert.rejects(service.getById(event.event_id, stranger), EventAccessDeniedError);
  } finally {
    await db.execute("DELETE FROM events WHERE event_id = ?", [event.event_id]);
  }
  await assert.rejects(service.getById(event.event_id, owner), EventNotFoundError);
});
