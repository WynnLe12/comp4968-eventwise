import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { InvitationRepository } from "../event-service/repositories/invitationRepository";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../event-service/services/eventService";
import { InvitationService } from "../event-service/services/invitationService";
import { db } from "../shared/db/db";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const env = { EVENTS_ORGANIZER_ORIGIN: "https://organizer.example" };
after(async () => { await db.end(); });

async function withEvents(run: (fixture: { eventId: string; otherEventId: string; owner: string; coPlanner: string }) => Promise<void>) {
  const repo = new EventRepository();
  const owner = `invite-owner-${randomUUID()}`;
  const coPlanner = `invite-co-${randomUUID()}`;
  const input = { name: "Invitation test", template_id: null, event_date: null, venue: null, total_budget: "0.00" };
  const ids: string[] = [];
  try {
    ids.push((await repo.create(input, owner)).event_id);
    ids.push((await repo.create(input, owner)).event_id);
    await db.execute("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'CO_PLANNER')", [ids[0], coPlanner]);
    await run({ eventId: ids[0], otherEventId: ids[1], owner, coPlanner });
  } finally {
    for (const id of ids) await db.execute("DELETE FROM events WHERE event_id = ?", [id]);
  }
}

test("MySQL: owner-only create/list/revoke preserve history and never affect other event memberships", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner, coPlanner }) => {
    const service = new InvitationService(undefined, env);
    assert.deepEqual(await service.list(eventId, owner), []);
    const invite = await service.create(eventId, { email: " Planner@Example.com " }, owner);
    assert.equal(invite.email, "planner@example.com");
    assert.equal(typeof invite.invitation_id, "string");
    assert.equal(Date.parse(invite.expires_at) - Date.parse(invite.created_at), 48 * 60 * 60 * 1000);
    const token = new URLSearchParams(new URL(invite.acceptance_url).hash.slice(1)).get("token")!;
    const [created] = await db.execute<RowDataPacket[]>(
      "SELECT token_hash, invited_by_sub, pending_email FROM event_invitations WHERE invitation_id = ?", [invite.invitation_id],
    );
    assert.deepEqual({ ...created[0] }, {
      token_hash: createHash("sha256").update(token).digest("hex"), invited_by_sub: owner, pending_email: invite.email,
    });
    const { acceptance_url: _link, ...publicInvite } = invite;
    assert.deepEqual(await service.list(eventId, owner), [publicInvite]);
    assert.deepEqual(await service.list(otherEventId, owner), []);
    for (const sub of [coPlanner, "unrelated", owner.toUpperCase()]) {
      await assert.rejects(service.create(eventId, { email: invite.email }, sub), EventAccessDeniedError);
      await assert.rejects(service.list(eventId, sub), EventAccessDeniedError);
      await assert.rejects(service.revoke(eventId, invite.invitation_id, sub), EventAccessDeniedError);
    }
    await assert.rejects(service.revoke(otherEventId, invite.invitation_id, owner), EventNotFoundError);
    await assert.rejects(service.create(eventId, { email: "PLANNER@EXAMPLE.COM" }, owner), EventConflictError);
    await service.revoke(eventId, invite.invitation_id, owner);
    await service.revoke(eventId, invite.invitation_id, owner);
    assert.deepEqual(await service.list(eventId, owner), []);
    const replacement = await service.create(eventId, { email: invite.email }, owner);
    assert.notEqual(replacement.invitation_id, invite.invitation_id);
    const [history] = await db.execute<RowDataPacket[]>(
      "SELECT status FROM event_invitations WHERE event_id = ? ORDER BY invitation_id", [eventId],
    );
    assert.deepEqual(history.map(row => row.status), ["REVOKED", "PENDING"]);
    assert.equal((await new EventRepository().listMembers(eventId, owner)).length, 2);
  });
});

test("MySQL: concurrent duplicate creation, stale pending expiry, and accepted revocation", integration, async () => {
  await withEvents(async ({ eventId, owner }) => {
    const service = new InvitationService(undefined, env);
    const results = await Promise.allSettled([
      service.create(eventId, { email: "planner@example.com" }, owner),
      service.create(eventId, { email: "PLANNER@example.com" }, owner),
    ]);
    const successful = results.filter(result => result.status === "fulfilled");
    assert.equal(successful.length, 1);
    const rejected = results.find(result => result.status === "rejected");
    assert.ok(rejected?.reason instanceof EventConflictError);
    const invite = successful[0].value;
    assert.equal((await service.list(eventId, owner)).length, 1);
    await assert.rejects(db.execute(
      `INSERT INTO event_invitations (event_id, email, invited_by_sub, token_hash, expires_at)
       VALUES (?, ' PLANNER@example.com ', ?, ?, UTC_TIMESTAMP() + INTERVAL 1 DAY)`,
      [eventId, owner, "a".repeat(64)],
    ), { code: "ER_DUP_ENTRY" });
    await db.execute("UPDATE event_invitations SET expires_at = UTC_TIMESTAMP() WHERE invitation_id = ?", [invite.invitation_id]);
    assert.deepEqual(await service.list(eventId, owner), []);
    await assert.rejects(service.revoke(eventId, invite.invitation_id, owner), EventConflictError);
    const replacement = await service.create(eventId, { email: invite.email }, owner);
    await assert.rejects(service.revoke(eventId, invite.invitation_id, owner), EventConflictError);
    await db.execute("UPDATE event_invitations SET status = 'ACCEPTED' WHERE invitation_id = ?", [replacement.invitation_id]);
    await assert.rejects(service.revoke(eventId, replacement.invitation_id, owner), EventConflictError);
    assert.deepEqual(await service.list(eventId, owner), []);
    const [history] = await db.execute<RowDataPacket[]>(
      "SELECT status FROM event_invitations WHERE event_id = ? ORDER BY invitation_id", [eventId],
    );
    assert.deepEqual(history.map(row => row.status), ["EXPIRED", "ACCEPTED"]);
  });
});

test("MySQL: failure after insert rolls back the new row and the previous invitation's expiry transition", integration, async () => {
  await withEvents(async ({ eventId, owner }) => {
    const service = new InvitationService(undefined, env);
    const email = "planner@example.com";
    const invite = await service.create(eventId, { email }, owner);
    await db.execute("UPDATE event_invitations SET expires_at = UTC_TIMESTAMP() WHERE invitation_id = ?", [invite.invitation_id]);
    const repo = new InvitationRepository({ getConnection: async () => {
      const connection = await db.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          if (property === "execute") return (sql: string, params?: string[]) => {
            if (sql.includes("LAST_INSERT_ID()")) throw new Error("Injected failure after insert");
            return target.execute(sql, params);
          };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolConnection;
    } });
    await assert.rejects(new InvitationService(repo, env).create(eventId, { email }, owner), /Injected failure/);
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT CAST(invitation_id AS CHAR) AS invitation_id, status FROM event_invitations WHERE event_id = ?", [eventId],
    );
    assert.deepEqual(rows.map(row => ({ ...row })), [{ invitation_id: invite.invitation_id, status: "PENDING" }]);
    assert.notEqual((await service.create(eventId, { email }, owner)).invitation_id, invite.invitation_id);
  });
});
