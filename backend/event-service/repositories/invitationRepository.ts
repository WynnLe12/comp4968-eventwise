import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { db } from "../../shared/db/db";
import { normalizeInvitationEmail } from "../invitationEmail";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../services/eventService";

export class InvitationInactiveError extends Error {}

type InvitationCreationStep = "connect-or-authorize" | "find-pending-invitation" | "expire-invitation" |
  "insert-invitation" | "read-created-invitation" | "commit";

export class InvitationCreationError extends Error {
  constructor(readonly step: InvitationCreationStep, cause: unknown) {
    super("Invitation creation failed", { cause });
  }
}

export interface PendingInvitation {
  invitation_id: string;
  email: string;
  status: "PENDING";
  expires_at: string;
  created_at: string;
}

interface InvitationRow extends RowDataPacket {
  invitation_id: string;
  email: string;
  expires_at: string;
  created_at_epoch: number | string;
}

const invitationFields = `CAST(i.invitation_id AS CHAR) AS invitation_id, i.email,
  DATE_FORMAT(i.expires_at, '%Y-%m-%dT%H:%i:%s.000Z') AS expires_at,
  UNIX_TIMESTAMP(i.created_at) AS created_at_epoch`;
const ownerPredicate = `m.event_id = ? AND m.cognito_sub = ?
  AND CAST(m.cognito_sub AS BINARY) = CAST(? AS BINARY) AND m.role = 'OWNER'`;

function pendingInvitation(row: InvitationRow): PendingInvitation {
  return {
    invitation_id: row.invitation_id,
    email: row.email,
    status: "PENDING",
    expires_at: row.expires_at,
    created_at: new Date(Number(row.created_at_epoch) * 1000).toISOString(),
  };
}

export class InvitationRepository {
  constructor(private readonly pool: Pick<Pool, "getConnection"> = db) {}

  private async withEventTransaction<T>(
    connection: PoolConnection,
    eventId: string,
    missingEvent: Error,
    operation: () => Promise<T>,
  ): Promise<T> {
    await connection.beginTransaction();
    try {
      // Take the same event lock for every write before touching invitation rows.
      const [events] = await connection.execute<RowDataPacket[]>(
        "SELECT event_id FROM events WHERE event_id = ? FOR UPDATE", [eventId],
      );
      if (!events.length) throw missingEvent;
      const result = await operation();
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  private async withOwnerTransaction<T>(
    eventId: string,
    sub: string,
    operation: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    const forbidden = new EventAccessDeniedError("Only the event owner can manage invitations");
    try {
      return await this.withEventTransaction(connection, eventId, forbidden, async () => {
        const [owners] = await connection.execute<RowDataPacket[]>(
          `SELECT 1 FROM event_members m WHERE ${ownerPredicate} FOR SHARE`, [eventId, sub, sub],
        );
        if (!owners.length) throw forbidden;
        return operation(connection);
      });
    } finally {
      connection.release();
    }
  }

  async create(eventId: string, sub: string, email: string, tokenHash: string): Promise<PendingInvitation> {
    let step: InvitationCreationStep = "connect-or-authorize";
    try {
      return await this.withOwnerTransaction(eventId, sub, async connection => {
        // Start the read after taking the event lock. Avoid gap locks on a missing
        // invitation key, which could block inserts for a different event.
        step = "find-pending-invitation";
        const [pending] = await connection.execute<(RowDataPacket & { invitation_id: string; elapsed: number | string })[]>(
          `SELECT CAST(invitation_id AS CHAR) AS invitation_id, expires_at <= UTC_TIMESTAMP() AS elapsed
           FROM event_invitations WHERE event_id = ? AND pending_email = ?`,
          [eventId, email],
        );
        if (pending[0]) {
          if (Number(pending[0].elapsed) !== 1) throw new EventConflictError("A pending invitation already exists for this email");
          step = "expire-invitation";
          await connection.execute(
            "UPDATE event_invitations SET status = 'EXPIRED' WHERE event_id = ? AND invitation_id = ? AND status = 'PENDING'",
            [eventId, pending[0].invitation_id],
          );
        }

        step = "insert-invitation";
        await connection.execute(
          `INSERT INTO event_invitations (event_id, email, invited_by_sub, token_hash, status, expires_at)
           VALUES (?, ?, ?, ?, 'PENDING', UTC_TIMESTAMP() + INTERVAL 48 HOUR)`,
          [eventId, email, sub, tokenHash],
        );
        step = "read-created-invitation";
        const [rows] = await connection.execute<InvitationRow[]>(
          `SELECT ${invitationFields} FROM event_invitations i WHERE i.invitation_id = LAST_INSERT_ID()`,
        );
        if (!rows[0]) throw new Error("Created invitation could not be read");
        const invitation = pendingInvitation(rows[0]);
        step = "commit";
        return invitation;
      });
    } catch (error) {
      if (error instanceof EventAccessDeniedError || error instanceof EventConflictError) throw error;
      throw new InvitationCreationError(step, error);
    }
  }

  async list(eventId: string, sub: string): Promise<PendingInvitation[]> {
    const connection = await this.pool.getConnection();
    try {
      // Preserve one row for an owner with no active invitations, and zero for a denied caller.
      const [rows] = await connection.execute<(InvitationRow | (RowDataPacket & { invitation_id: null }))[]>(
        `SELECT ${invitationFields}
         FROM event_members m
         LEFT JOIN event_invitations i ON i.event_id = m.event_id
           AND i.status = 'PENDING' AND i.expires_at > UTC_TIMESTAMP()
         WHERE ${ownerPredicate}
         ORDER BY i.created_at DESC, i.invitation_id DESC`,
        [eventId, sub, sub],
      );
      if (!rows.length) throw new EventAccessDeniedError("Only the event owner can manage invitations");
      return rows.flatMap(row => row.invitation_id === null ? [] : [pendingInvitation(row)]);
    } finally {
      connection.release();
    }
  }

  async revoke(eventId: string, invitationId: string, sub: string): Promise<void> {
    await this.withOwnerTransaction(eventId, sub, async connection => {
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE event_invitations SET status = 'REVOKED'
         WHERE event_id = ? AND invitation_id = ? AND status = 'PENDING' AND expires_at > UTC_TIMESTAMP()`,
        [eventId, invitationId],
      );
      if (result.affectedRows === 1) return;
      const [rows] = await connection.execute<(RowDataPacket & { status: string })[]>(
        "SELECT status FROM event_invitations WHERE event_id = ? AND invitation_id = ? FOR UPDATE",
        [eventId, invitationId],
      );
      if (!rows[0]) throw new EventNotFoundError("Invitation not found");
      if (rows[0].status !== "REVOKED") throw new EventConflictError("Only active pending invitations can be revoked");
    });
  }

  async accept(tokenHash: string, sub: string, email: string): Promise<{
    event_id: string;
    member_id: string;
    role: "CO_PLANNER";
  }> {
    const connection = await this.pool.getConnection();
    const notFound = new EventNotFoundError("Invitation not found");
    const inactive = new InvitationInactiveError("This invitation has expired or been revoked");
    const alreadyMember = new EventConflictError("You already belong to this event");
    try {
      // Discover the event without locking an invitation before the event row.
      const [candidates] = await connection.execute<(RowDataPacket & { event_id: string })[]>(
        "SELECT CAST(event_id AS CHAR) AS event_id FROM event_invitations WHERE token_hash = ?", [tokenHash],
      );
      if (!candidates[0]) throw notFound;
      const eventId = candidates[0].event_id;

      return await this.withEventTransaction(connection, eventId, notFound, async () => {
        const [rows] = await connection.execute<(RowDataPacket & {
          invitation_id: string; email: string; status: string; elapsed: number | string;
        })[]>(
          `SELECT CAST(invitation_id AS CHAR) AS invitation_id, email, status,
             expires_at <= UTC_TIMESTAMP() AS elapsed
           FROM event_invitations WHERE event_id = ? AND token_hash = ? FOR UPDATE`,
          [eventId, tokenHash],
        );
        const invitation = rows[0];
        if (!invitation) throw notFound;
        if (normalizeInvitationEmail(invitation.email) !== email) {
          throw new EventAccessDeniedError("A matching verified email is required");
        }
        if (invitation.status === "ACCEPTED") throw new EventConflictError("This invitation has already been accepted");
        if (invitation.status !== "PENDING" || Number(invitation.elapsed) === 1) throw inactive;

        const [members] = await connection.execute<RowDataPacket[]>(
          "SELECT 1 FROM event_members WHERE event_id = ? AND cognito_sub = ?", [eventId, sub],
        );
        if (members.length) throw alreadyMember;
        try {
          await connection.execute(
            "INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'CO_PLANNER')", [eventId, sub],
          );
        } catch (error) {
          if ((error as { code?: string } | null)?.code === "ER_DUP_ENTRY") throw alreadyMember;
          throw error;
        }
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE event_invitations SET status = 'ACCEPTED', accepted_at = UTC_TIMESTAMP()
           WHERE event_id = ? AND invitation_id = ? AND status = 'PENDING' AND expires_at > UTC_TIMESTAMP()`,
          [eventId, invitation.invitation_id],
        );
        if (updated.affectedRows !== 1) throw inactive;
        const [inserted] = await connection.execute<(RowDataPacket & { member_id: string })[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS member_id",
        );
        if (!inserted[0]) throw new Error("Accepted membership could not be read");
        return { event_id: eventId, member_id: inserted[0].member_id, role: "CO_PLANNER" };
      });
    } finally {
      connection.release();
    }
  }
}
