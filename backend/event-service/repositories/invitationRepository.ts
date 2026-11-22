import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { db } from "../../shared/db/db";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError } from "../services/eventService";

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

  private async withOwnerTransaction<T>(
    eventId: string,
    sub: string,
    operation: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Take the same event lock for every write before touching invitation rows.
      const [events] = await connection.execute<RowDataPacket[]>(
        "SELECT event_id FROM events WHERE event_id = ? FOR UPDATE", [eventId],
      );
      if (!events.length) throw new EventAccessDeniedError("Only the event owner can manage invitations");
      const [owners] = await connection.execute<RowDataPacket[]>(
        `SELECT 1 FROM event_members m WHERE ${ownerPredicate} FOR SHARE`, [eventId, sub, sub],
      );
      if (!owners.length) throw new EventAccessDeniedError("Only the event owner can manage invitations");
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async create(eventId: string, sub: string, email: string, tokenHash: string): Promise<PendingInvitation> {
    return this.withOwnerTransaction(eventId, sub, async connection => {
      // Start the read after taking the event lock. Avoid gap locks on a missing
      // invitation key, which could block inserts for a different event.
      const [pending] = await connection.execute<(RowDataPacket & { invitation_id: string; elapsed: number | string })[]>(
        `SELECT CAST(invitation_id AS CHAR) AS invitation_id, expires_at <= UTC_TIMESTAMP() AS elapsed
         FROM event_invitations WHERE event_id = ? AND pending_email = ?`,
        [eventId, email],
      );
      if (pending[0]) {
        if (Number(pending[0].elapsed) !== 1) throw new EventConflictError("A pending invitation already exists for this email");
        await connection.execute(
          "UPDATE event_invitations SET status = 'EXPIRED' WHERE event_id = ? AND invitation_id = ? AND status = 'PENDING'",
          [eventId, pending[0].invitation_id],
        );
      }

      await connection.execute(
        `INSERT INTO event_invitations (event_id, email, invited_by_sub, token_hash, status, expires_at)
         VALUES (?, ?, ?, ?, 'PENDING', UTC_TIMESTAMP() + INTERVAL 48 HOUR)`,
        [eventId, email, sub, tokenHash],
      );
      const [rows] = await connection.execute<InvitationRow[]>(
        `SELECT ${invitationFields} FROM event_invitations i WHERE i.invitation_id = LAST_INSERT_ID()`,
      );
      if (!rows[0]) throw new Error("Created invitation could not be read");
      return pendingInvitation(rows[0]);
    });
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
}
