import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createEventsHandler, type EventsProxyEvent } from "../event-service/lambda/events";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { EventConflictError, EventService } from "../event-service/services/eventService";
import { InvitationService } from "../event-service/services/invitationService";
import { requireMember } from "../shared/auth/requireMember";
import { db } from "../shared/db/db";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const env = {
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
  EVENTS_ORGANIZER_ORIGIN: "https://organizer.example",
};
after(async () => { await db.end(); });

function proxy(method: string, eventId: string | null, sub: string, memberId?: string, roster = false): EventsProxyEvent {
  const collection = eventId === null;
  const suffix = memberId ? `/members/${memberId}` : roster ? "/members" : "";
  return {
    httpMethod: method, path: collection ? "/events" : `/events/${eventId}${suffix}`,
    resource: collection ? "/events" : `/events/{eventId}${memberId ? "/members/{memberId}" : suffix}`,
    pathParameters: collection ? null : { eventId, ...(memberId ? { memberId } : {}) },
    headers: { Authorization: "Bearer same-existing-token" },
    requestContext: { authorizer: { claims: {
      sub, token_use: "access", client_id: env.COGNITO_CLIENT_ID,
      iss: `https://cognito-idp.us-west-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
    } } },
  };
}

async function withEvents(run: (fixture: {
  eventId: string; otherEventId: string; owner: string; otherOwner: string; removed: string; kept: string;
}) => Promise<void>) {
  const repo = new EventRepository();
  const owner = `owner-${randomUUID()}`;
  const otherOwner = `owner-${randomUUID()}`;
  const removed = `co-${randomUUID()}`;
  const kept = `co-${randomUUID()}`;
  const input = { name: "Removal test", template_id: null, event_date: null, venue: null, total_budget: "0.00" };
  const ids: string[] = [];
  try {
    ids.push((await repo.create(input, owner)).event_id);
    ids.push((await repo.create(input, otherOwner)).event_id);
    await db.execute(
      `INSERT INTO event_members (event_id, cognito_sub, role)
       VALUES (?, ?, 'CO_PLANNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'CO_PLANNER')`,
      [ids[0], removed, ids[0], kept, ids[1], removed],
    );
    await run({ eventId: ids[0], otherEventId: ids[1], owner, otherOwner, removed, kept });
  } finally {
    for (const id of ids.reverse()) await db.execute("DELETE FROM events WHERE event_id = ?", [id]);
  }
}

async function memberId(eventId: string, sub: string): Promise<string> {
  const [rows] = await db.execute<(RowDataPacket & { member_id: string })[]>(
    "SELECT CAST(member_id AS CHAR) AS member_id FROM event_members WHERE event_id = ? AND cognito_sub = ?", [eventId, sub],
  );
  return rows[0].member_id;
}

async function tasks(eventId: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT title, CAST(assigned_member_id AS CHAR) AS assigned_member_id
     FROM tasks WHERE event_id = ? ORDER BY task_id`, [eventId],
  );
  return rows.map(row => ({ ...row }));
}

function repositoryBeforeDelete(before: (connection: PoolConnection, sql: string, params?: string[]) => Promise<void>) {
  return new EventRepository({
    getConnection: async () => {
      const connection = await db.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          if (property === "execute") return async (sql: string, params?: string[]) => {
            if (sql.startsWith("DELETE FROM event_members")) await before(target, sql, params);
            return target.execute(sql, params);
          };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolConnection;
    },
  });
}

test("MySQL: owner removes only the selected membership; tasks survive and identical JWT claims lose access", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner, removed, kept }) => {
    const handler = createEventsHandler({ service: new EventService(), env });
    const targetId = await memberId(eventId, removed);
    const keptId = await memberId(eventId, kept);
    const otherId = await memberId(otherEventId, removed);
    await db.execute(
      "INSERT INTO tasks (event_id, title, assigned_member_id) VALUES (?, 'Cleared', ?), (?, 'Kept', ?), (?, 'Other event', ?)",
      [eventId, targetId, eventId, keptId, otherEventId, otherId],
    );
    const list = proxy("GET", null, removed);
    const detail = proxy("GET", eventId, removed);
    const roster = proxy("GET", eventId, removed, undefined, true);
    assert.equal(JSON.parse((await handler(list)).body).length, 2);
    for (const request of [detail, roster]) assert.equal((await handler(request)).statusCode, 200);
    assert.equal(await requireMember(eventId, removed), eventId);

    const result = await handler(proxy("DELETE", eventId, owner, targetId));
    assert.equal(result.statusCode, 204);
    assert.equal(result.body, "");
    const response = await handler(list);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).map((event: { event_id: string }) => event.event_id), [otherEventId]);
    for (const request of [detail, roster]) assert.equal((await handler(request)).statusCode, 403);
    await assert.rejects(requireMember(eventId, removed), { status: 403 });
    assert.equal((await handler(proxy("GET", otherEventId, removed))).statusCode, 200);
    const remaining = JSON.parse((await handler(proxy("GET", eventId, owner, undefined, true))).body);
    assert.deepEqual(remaining.map((member: { member_id: string }) => member.member_id), [await memberId(eventId, owner), keptId]);
    assert.deepEqual(await tasks(eventId), [
      { title: "Cleared", assigned_member_id: null }, { title: "Kept", assigned_member_id: keptId },
    ]);
    assert.deepEqual(await tasks(otherEventId), [{ title: "Other event", assigned_member_id: otherId }]);
  });
});

test("MySQL: owner and cross-event targets are protected and a corrupt task reference blocks removal", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner, otherOwner, removed, kept }) => {
    const handler = createEventsHandler({ service: new EventService(), env });
    const targetId = await memberId(eventId, removed);
    const keptId = await memberId(eventId, kept);
    for (const sub of [kept, removed, "unrelated", owner.toUpperCase()]) {
      assert.equal((await handler(proxy("DELETE", eventId, sub, targetId))).statusCode, 403);
    }
    assert.equal((await handler(proxy("DELETE", eventId, removed, keptId))).statusCode, 403);
    assert.equal((await handler(proxy("DELETE", eventId, owner, await memberId(eventId, owner)))).statusCode, 409);
    assert.equal((await handler(proxy("DELETE", eventId, owner, await memberId(otherEventId, otherOwner)))).statusCode, 404);
    assert.equal((await handler(proxy("DELETE", eventId, owner, await memberId(otherEventId, removed)))).statusCode, 404);
    assert.equal((await handler(proxy("DELETE", "18446744073709551615", owner, targetId))).statusCode, 403);
    await db.execute(
      "INSERT INTO tasks (event_id, title, assigned_member_id) VALUES (?, 'Local assignment', ?), (?, 'Corrupt assignment', ?)",
      [eventId, targetId, otherEventId, targetId],
    );
    const response = await handler(proxy("DELETE", eventId, owner, targetId));
    assert.equal(response.statusCode, 409);
    assert.match(JSON.parse(response.body).error, /task in another event/);
    assert.equal(await memberId(eventId, removed), targetId);
    assert.deepEqual(await tasks(eventId), [{ title: "Local assignment", assigned_member_id: targetId }]);
    assert.deepEqual(await tasks(otherEventId), [{ title: "Corrupt assignment", assigned_member_id: targetId }]);
  });
});

test("MySQL: removal rolls back the membership deletion and task cascade after a database failure", integration, async () => {
  await withEvents(async ({ eventId, owner, removed }) => {
    const targetId = await memberId(eventId, removed);
    await db.execute("INSERT INTO tasks (event_id, title, assigned_member_id) VALUES (?, 'Assigned', ?)", [eventId, targetId]);
    const repo = repositoryBeforeDelete(async (connection, sql, params) => {
      await connection.execute(sql, params);
      throw new Error("Injected after membership deletion");
    });
    await assert.rejects(new EventService(repo).removeMember(eventId, targetId, owner), /Injected after/);
    assert.equal(await memberId(eventId, removed), targetId);
    assert.deepEqual(await tasks(eventId), [{ title: "Assigned", assigned_member_id: targetId }]);
    await new EventService().removeMember(eventId, targetId, owner);
    assert.deepEqual(await tasks(eventId), [{ title: "Assigned", assigned_member_id: null }]);
  });
});

test("MySQL: locked task assignments cannot move to another event before the cascade", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner, removed }) => {
    const targetId = await memberId(eventId, removed);
    await db.execute("INSERT INTO tasks (event_id, title, assigned_member_id) VALUES (?, 'Assigned', ?)", [eventId, targetId]);
    const repo = repositoryBeforeDelete(async () => {
      const mover = await db.getConnection();
      try {
        await mover.query("SET SESSION innodb_lock_wait_timeout = 1");
        await assert.rejects(mover.execute(
          "UPDATE tasks SET event_id = ? WHERE event_id = ? AND assigned_member_id = ?", [otherEventId, eventId, targetId],
        ), { code: "ER_LOCK_WAIT_TIMEOUT" });
      } finally {
        try { await mover.query("SET SESSION innodb_lock_wait_timeout = DEFAULT"); }
        finally { mover.release(); }
      }
    });
    await new EventService(repo).removeMember(eventId, targetId, owner);
    assert.deepEqual(await tasks(eventId), [{ title: "Assigned", assigned_member_id: null }]);
    assert.deepEqual(await tasks(otherEventId), []);
  });
});

test("MySQL: concurrent removal and invitation acceptance serialize without altering the owner or unrelated memberships", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner, removed, kept }) => {
    const repo = new EventRepository();
    const invitations = new InvitationService(undefined, env);
    const targetId = await memberId(eventId, removed);
    const unrelatedId = await memberId(otherEventId, removed);
    const invitation = await invitations.create(eventId, { email: "planner@example.com" }, owner);
    const token = new URLSearchParams(new URL(invitation.acceptance_url).hash.slice(1)).get("token")!;
    const [accept, removal] = await Promise.allSettled([
      invitations.accept({ token }, removed, "mock", async () => "planner@example.com"),
      new EventService(repo).removeMember(eventId, targetId, owner),
    ]);
    assert.equal(removal.status, "fulfilled");
    const roster = await repo.listMembers(eventId, owner);
    assert.ok(!roster.some(member => member.member_id === targetId));
    assert.ok(roster.some(member => member.cognito_sub === owner && member.role === "OWNER"));
    assert.ok(roster.some(member => member.cognito_sub === kept && member.role === "CO_PLANNER"));
    const rejoined = roster.filter(member => member.cognito_sub === removed);
    if (accept.status === "fulfilled") {
      assert.deepEqual(rejoined.map(member => member.member_id), [accept.value.member_id]);
      assert.deepEqual(await invitations.list(eventId, owner), []);
    } else {
      assert.ok(accept.reason instanceof EventConflictError);
      assert.deepEqual(rejoined, []);
      assert.equal((await invitations.list(eventId, owner))[0].invitation_id, invitation.invitation_id);
    }
    assert.equal(await memberId(otherEventId, removed), unrelatedId);
  });
});
