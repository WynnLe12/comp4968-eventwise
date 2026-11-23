import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createEventsHandler, type EventsProxyEvent } from "../event-service/lambda/events";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { InvitationCreationError, InvitationInactiveError, InvitationRepository } from "../event-service/repositories/invitationRepository";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../event-service/services/eventService";
import { InvitationService } from "../event-service/services/invitationService";
import { db } from "../shared/db/db";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const env = { EVENTS_ORGANIZER_ORIGIN: "https://organizer.example" };
const emailEnv = {
  ...env, EVENTS_INVITATION_EMAIL_KEY: Buffer.alloc(32, 7).toString("base64"),
  EVENTS_INVITATION_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/eventwise-invitation-emails",
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
};
const verifiedPlanner = (sub: string) => ({ sub, email: " Planner@Example.com " });
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

async function invitePlanner(service: InvitationService, eventId: string, owner: string) {
  const invitation = await service.create(eventId, { email: "planner@example.com" }, owner);
  const token = new URLSearchParams(new URL(invitation.acceptance_url).hash.slice(1)).get("token")!;
  return { token, invitationId: invitation.invitation_id };
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
    const { acceptance_url: _link, email_status, email_retry, ...publicInvite } = invite;
    assert.equal(email_status, "not_configured");
    assert.equal(email_retry, false);
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

test("MySQL: SQS failure preserves an encrypted retry; the same POST queues the original link without another invitation", integration, async t => {
  const warning = t.mock.method(console, "warn", () => {});
  await withEvents(async ({ eventId, owner, coPlanner }) => {
    const emails: { to: string; eventName: string; invitationUrl: string }[] = [];
    let resolvePublish!: () => void;
    let startPublish!: () => void;
    const publishStarted = new Promise<void>(resolve => { startPublish = resolve; });
    const completing = new Promise<void>(resolve => { resolvePublish = resolve; });
    const invites = new InvitationService(undefined, emailEnv, async (queue, message) => {
      assert.equal(queue, emailEnv.EVENTS_INVITATION_QUEUE_URL);
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT email_envelope, token_hash FROM event_invitations WHERE event_id = ?", [eventId],
      );
      assert.equal(rows.length, 1, "Invitation must be committed before publishing");
      assert.ok(Buffer.isBuffer(rows[0].email_envelope) && !rows[0].email_envelope.includes(Buffer.from(message.invitationUrl)));
      const token = new URLSearchParams(new URL(message.invitationUrl).hash.slice(1)).get("token")!;
      assert.equal(createHash("sha256").update(token).digest("hex"), rows[0].token_hash);
      emails.push(message);
      if (emails.length === 1) throw new Error(`Sensitive queue failure: ${message.invitationUrl}`);
      startPublish();
      await completing;
    });
    const handler = createEventsHandler({ invitations: invites, env: emailEnv });
    const request = (sub = owner): EventsProxyEvent => ({
      httpMethod: "POST", path: `/events/${eventId}/invitations`, resource: "/events/{eventId}/invitations",
      pathParameters: { eventId }, headers: { "Content-Type": "application/json" }, body: '{"email":" Planner@Example.com "}',
      requestContext: { authorizer: { claims: {
        sub, token_use: "access", client_id: emailEnv.COGNITO_CLIENT_ID,
        iss: `https://cognito-idp.us-west-2.amazonaws.com/${emailEnv.COGNITO_USER_POOL_ID}`,
      } } },
    });
    const first = await handler(request());
    const original = JSON.parse(first.body);
    assert.equal(first.statusCode, 201);
    assert.equal(first.headers["Cache-Control"], "no-store");
    assert.equal(original.email_status, "retryable");
    assert.equal(emails[0].invitationUrl, original.acceptance_url);
    assert.equal((await handler(request(coPlanner))).statusCode, 403);
    assert.equal(emails.length, 1);
    const retry = handler(request());
    try {
      const reachedPublisher = await Promise.race([publishStarted.then(() => true), retry.then(() => false)]);
      assert.ok(reachedPublisher);
      assert.equal((await handler(request())).statusCode, 409);
    } finally {
      resolvePublish();
    }
    const retried = await retry;
    const response = JSON.parse(retried.body);
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.headers["Cache-Control"], "no-store");
    assert.deepEqual(response, { ...original, email_status: "queued" });
    assert.deepEqual(emails, [0, 1].map(() => ({
      to: "planner@example.com", eventName: "Invitation test", invitationUrl: original.acceptance_url,
    })));
    assert.equal((await handler(request())).statusCode, 409);
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT email_envelope, email_queued_at, email_claim_id, status FROM event_invitations WHERE event_id = ?", [eventId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "PENDING");
    assert.ok(rows[0].email_queued_at);
    assert.equal(rows[0].email_envelope, null);
    assert.equal(rows[0].email_claim_id, null);
    assert.deepEqual(warning.mock.calls.map(call => call.arguments), [["Invitation email could not be queued"]]);
  });
});

test("MySQL: legacy pending invitations still conflict and cannot be emailed with a replacement token", integration, async () => {
  await withEvents(async ({ eventId, owner }) => {
    const body = { email: "planner@example.com" };
    await new InvitationService(undefined, env).create(eventId, body, owner);
    const configured = new InvitationService(undefined, emailEnv, async () => assert.fail("No original link is available"));
    await assert.rejects(configured.create(eventId, body, owner), EventConflictError);
  });
});

test("MySQL: an unreleased email claim can be retried after its lease expires", integration, async t => {
  t.mock.method(console, "warn", () => {});
  await withEvents(async ({ eventId, owner }) => {
    class InterruptedRepository extends InvitationRepository {
      override async finishEmail(): Promise<void> {
        throw new Error("Simulated failure recording the queue result");
      }
    }
    const body = { email: "planner@example.com" };
    const initial = new InvitationService(new InterruptedRepository(), emailEnv, async () => {
      throw new Error("Simulated queue failure");
    });
    const first = await initial.create(eventId, body, owner);
    assert.equal(first.email_status, "retryable");
    const retry = new InvitationService(undefined, emailEnv, async (_queueUrl, message) => {
      assert.equal(message.invitationUrl, first.acceptance_url);
    });
    await assert.rejects(retry.create(eventId, body, owner), /already being queued/);
    await db.execute(
      "UPDATE event_invitations SET email_claim_until = UTC_TIMESTAMP(6) WHERE invitation_id = ?", [first.invitation_id],
    );
    const final = await retry.create(eventId, body, owner);
    assert.deepEqual(final, { ...first, email_status: "queued", email_retry: true });
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
    await assert.rejects(new InvitationService(repo, env).create(eventId, { email }, owner), error =>
      error instanceof InvitationCreationError && error.step === "read-created-invitation" &&
      error.cause instanceof Error && error.cause.message === "Injected failure after insert");
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT CAST(invitation_id AS CHAR) AS invitation_id, status FROM event_invitations WHERE event_id = ?", [eventId],
    );
    assert.deepEqual(rows.map(row => ({ ...row })), [{ invitation_id: invite.invitation_id, status: "PENDING" }]);
    assert.notEqual((await service.create(eventId, { email }, owner)).invitation_id, invite.invitation_id);
  });
});

test("MySQL: acceptance creates only the invited event membership and records UTC acceptance", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner }) => {
    const service = new InvitationService(undefined, env);
    const { token, invitationId } = await invitePlanner(service, eventId, owner);
    const sub = `invitee-${randomUUID()}`;
    await assert.rejects(service.accept({ token }, { sub, email: "another@example.com" }), EventAccessDeniedError);
    await assert.rejects(service.accept({ token: Buffer.alloc(32).toString("base64url") }, verifiedPlanner(sub)), EventNotFoundError);
    const result = await service.accept({ token }, verifiedPlanner(sub));
    const [members] = await db.execute<RowDataPacket[]>(
      "SELECT CAST(member_id AS CHAR) AS member_id, CAST(event_id AS CHAR) AS event_id, role FROM event_members WHERE cognito_sub = ?",
      [sub],
    );
    assert.deepEqual(members.map(row => ({ ...row })), [result]);
    assert.equal(result.event_id, eventId);
    assert.equal(result.role, "CO_PLANNER");
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT status, ABS(TIMESTAMPDIFF(SECOND, accepted_at, UTC_TIMESTAMP())) AS seconds_ago, pending_email
       FROM event_invitations WHERE invitation_id = ?`, [invitationId],
    );
    assert.equal(rows[0].status, "ACCEPTED");
    assert.ok(rows[0].seconds_ago !== null && Number(rows[0].seconds_ago) <= 10);
    assert.equal(rows[0].pending_email, null);
    assert.deepEqual((await new EventRepository().list(sub)).map(event => event.event_id), [eventId]);
    assert.ok(!(await new EventRepository().listMembers(otherEventId, owner)).some(member => member.cognito_sub === sub));
    await assert.rejects(service.accept({ token }, verifiedPlanner(sub)), EventConflictError);
    await assert.rejects(service.accept({ token }, { sub, email: "another@example.com" }), EventAccessDeniedError);
    assert.deepEqual(await service.list(eventId, owner), []);
  });
});

test("MySQL: expired, revoked and already-member invitations do not add or change a membership", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner, coPlanner }) => {
    const service = new InvitationService(undefined, env);
    const expired = await invitePlanner(service, eventId, owner);
    await db.execute("UPDATE event_invitations SET expires_at = UTC_TIMESTAMP() WHERE invitation_id = ?", [expired.invitationId]);
    await assert.rejects(service.accept({ token: expired.token }, verifiedPlanner("another")), InvitationInactiveError);
    const revoked = await invitePlanner(service, eventId, owner);
    await service.revoke(eventId, revoked.invitationId, owner);
    await assert.rejects(service.accept({ token: revoked.token }, verifiedPlanner("another")), InvitationInactiveError);
    const active = await invitePlanner(service, eventId, owner);
    for (const existing of [owner, coPlanner]) {
      await assert.rejects(service.accept({ token: active.token }, verifiedPlanner(existing)), /already belong/);
    }
    assert.deepEqual((await new EventRepository().listMembers(eventId, owner)).map(member => member.role), ["OWNER", "CO_PLANNER"]);
    assert.equal((await service.list(eventId, owner))[0].invitation_id, active.invitationId);
    const other = await invitePlanner(service, otherEventId, owner);
    assert.equal((await service.accept({ token: other.token }, verifiedPlanner(coPlanner))).event_id, otherEventId);
  });
});

test("MySQL: only one concurrent acceptance wins and concurrent revocation has one consistent outcome", integration, async () => {
  await withEvents(async ({ eventId, otherEventId, owner }) => {
    const service = new InvitationService(undefined, env);
    const sub = `invitee-race-${randomUUID()}`;
    const { token } = await invitePlanner(service, eventId, owner);
    const attempts = await Promise.allSettled([
      service.accept({ token }, verifiedPlanner(sub)),
      service.accept({ token }, verifiedPlanner(sub)),
    ]);
    assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
    assert.ok(attempts.find(attempt => attempt.status === "rejected")?.reason instanceof EventConflictError);
    assert.equal((await new EventRepository().listMembers(eventId, owner)).filter(member => member.cognito_sub === sub).length, 1);

    const other = await invitePlanner(service, otherEventId, owner);
    const [accepted, revoked] = await Promise.allSettled([
      service.accept({ token: other.token }, verifiedPlanner(sub)),
      service.revoke(otherEventId, other.invitationId, owner),
    ]);
    const [rows] = await db.execute<RowDataPacket[]>("SELECT status FROM event_invitations WHERE invitation_id = ?", [other.invitationId]);
    const otherMembers = await new EventRepository().listMembers(otherEventId, owner);
    if (accepted.status === "fulfilled") {
      assert.ok(revoked.status === "rejected" && revoked.reason instanceof EventConflictError);
      assert.equal(rows[0].status, "ACCEPTED");
      assert.equal(otherMembers.filter(member => member.cognito_sub === sub).length, 1);
    } else {
      assert.ok(accepted.reason instanceof InvitationInactiveError);
      assert.equal(revoked.status, "fulfilled");
      assert.equal(rows[0].status, "REVOKED");
      assert.equal(otherMembers.length, 1);
    }
  });
});

test("MySQL: acceptance rollback restores both writes and a membership uniqueness violation is a conflict", integration, async () => {
  await withEvents(async ({ eventId, owner }) => {
    const service = new InvitationService(undefined, env);
    const invite = await invitePlanner(service, eventId, owner);
    const sub = `invitee-rollback-${randomUUID()}`;
    const eventRepository = new EventRepository();
    const originalMembers = await eventRepository.listMembers(eventId, owner);
    const intercepted = (mode: "rollback" | "uniqueness") => new InvitationService(new InvitationRepository({
      getConnection: async () => {
        const connection = await db.getConnection();
        return new Proxy(connection, {
          get(target, property) {
            if (property === "execute") return (sql: string, params?: string[]) => {
              if (mode === "rollback" && sql.includes("LAST_INSERT_ID()")) throw new Error("Injected after both writes");
              if (mode === "uniqueness" && sql.startsWith("SELECT 1 FROM event_members")) return Promise.resolve([[], []]);
              return target.execute(sql, params);
            };
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PoolConnection;
      },
    }), env);
    await assert.rejects(intercepted("rollback").accept({ token: invite.token }, verifiedPlanner(sub)), /Injected after both writes/);
    await assert.rejects(intercepted("uniqueness").accept({ token: invite.token }, verifiedPlanner(owner)), /already belong/);
    const [rows] = await db.execute<RowDataPacket[]>(
      "SELECT status, accepted_at FROM event_invitations WHERE invitation_id = ?", [invite.invitationId],
    );
    assert.deepEqual({ ...rows[0] }, { status: "PENDING", accepted_at: null });
    assert.deepEqual(await eventRepository.listMembers(eventId, owner), originalMembers);
    assert.equal((await service.accept({ token: invite.token }, verifiedPlanner(sub))).role, "CO_PLANNER");
  });
});
