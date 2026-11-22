import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { db } from "../shared/db/db";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { EventAccessDeniedError, EventService } from "../event-service/services/eventService";

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

test("MySQL: event roster checks exact membership and sorts owner, join time, then member ID", { skip: !enabled }, async () => {
  const repository = new EventRepository();
  const service = new EventService(repository);
  const owner = `roster-owner-${randomUUID()}`;
  const firstCoPlanner = `roster-first-${randomUUID()}`;
  const otherOwner = `roster-other-${randomUUID()}`;
  const input = { name: "Roster test", template_id: null, event_date: null, venue: null, total_budget: "0.00" };
  const eventIds: string[] = [];
  try {
    const event = await repository.create(input, owner);
    eventIds.push(event.event_id);
    const otherEvent = await repository.create(input, otherOwner);
    eventIds.push(otherEvent.event_id);
    const eventId = event.event_id;
    await db.execute(
      `UPDATE event_members SET joined_at = FROM_UNIXTIME(?) WHERE event_id = ? AND cognito_sub = ?`,
      [1795258800, eventId, owner],
    );
    await db.execute(
      `INSERT INTO event_members (event_id, cognito_sub, role, joined_at) VALUES
        (?, ?, 'CO_PLANNER', FROM_UNIXTIME(?)),
        (?, ?, 'CO_PLANNER', FROM_UNIXTIME(?)),
        (?, ?, 'CO_PLANNER', FROM_UNIXTIME(?))`,
      [eventId, `roster-late-${randomUUID()}`, 1795257000, eventId, firstCoPlanner, 1795255200,
        eventId, `roster-second-${randomUUID()}`, 1795255200],
    );

    const roster = await service.listMembers(eventId, firstCoPlanner);
    assert.deepEqual(roster.map(({ role, joined_at, is_self }) => [role, joined_at, is_self]), [
      ["OWNER", "2026-11-21T11:00:00.000Z", false],
      ["CO_PLANNER", "2026-11-21T10:00:00.000Z", true],
      ["CO_PLANNER", "2026-11-21T10:00:00.000Z", false],
      ["CO_PLANNER", "2026-11-21T10:30:00.000Z", false],
    ]);
    assert.ok(roster.every(member => typeof member.member_id === "string" && !("cognito_sub" in member)));
    assert.ok(BigInt(roster[1].member_id) < BigInt(roster[2].member_id));
    assert.equal((await service.listMembers(eventId, owner))[0].is_self, true);
    await assert.rejects(service.listMembers(eventId, otherOwner), EventAccessDeniedError);
    await assert.rejects(service.listMembers(eventId, owner.toUpperCase()), EventAccessDeniedError);
    await assert.rejects(service.listMembers(otherEvent.event_id, firstCoPlanner), EventAccessDeniedError);
  } finally {
    for (const id of eventIds) await db.execute("DELETE FROM events WHERE event_id = ?", [id]);
  }
});
