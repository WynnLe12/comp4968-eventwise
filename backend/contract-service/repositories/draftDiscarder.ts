import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import { getDatabasePool } from "../../shared/db/pool";
import { parseDraftVersion } from "../services/draftValidation";
import type { Draft, DraftDiscarder } from "../types";
import { selectDraft } from "./draftReader";
import { withContractEvent } from "./eventTransaction";

export class MySqlDraftDiscarder implements DraftDiscarder {
  constructor(private readonly connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection()) {}

  async discard(eventId: string, draftId: string, sub: string, body: unknown): Promise<Draft> {
    parseId(eventId, "eventId", true); parseId(draftId, "draftId", true);
    if (typeof sub !== "string" || !sub || sub.trim() !== sub || sub.length > 128) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const { version } = parseDraftVersion(body);
    return withContractEvent(this.connect, eventId, sub, false, async connection => {
      const [rows] = await connection.execute<(RowDataPacket & Pick<Draft, "status" | "version">)[]>(
        "SELECT status, CAST(version AS CHAR) AS version FROM draft_budget_items WHERE event_id = ? AND draft_id = ? FOR UPDATE",
        [eventId, draftId]);
      const current = rows[0];
      if (!current) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
      if (current.status === "CONFIRMED") {
        throw new ApiError(409, "DRAFT_NOT_EDITABLE", "A confirmed draft cannot be discarded.");
      }
      // An already-discarded draft is a successful retry, even with the original version.
      if (current.status !== "REJECTED") {
        if (current.version !== version) throw new ApiError(409, "DRAFT_CHANGED", "This draft changed. Reload it before discarding.");
        if (version === "18446744073709551615") throw new ApiError(409, "DRAFT_VERSION_LIMIT", "This draft cannot be changed further.");
        const [result] = await connection.execute<ResultSetHeader>(`
          UPDATE draft_budget_items SET status = 'REJECTED', version = version + 1, updated_by_sub = ?
          WHERE event_id = ? AND draft_id = ? AND version = ? AND status = 'DRAFT'
        `, [sub, eventId, draftId, version]);
        if (result.affectedRows !== 1) throw new ApiError(409, "DRAFT_CHANGED", "This draft changed. Reload it before discarding.");
      }
      // Draft-before-job locks are also required by future workers applying results.
      // This cancels local job state; workers must check draft status/version before saving.
      await connection.execute(`
        UPDATE contract_extraction_jobs SET status = 'CANCELLED', completed_at = UTC_TIMESTAMP(6)
        WHERE event_id = ? AND draft_id = ? AND status IN ('QUEUED','PROCESSING')
      `, [eventId, draftId]);
      const [saved] = await connection.execute<(RowDataPacket & Draft)[]>(
        selectDraft + " WHERE d.event_id = ? AND d.draft_id = ? LIMIT 1", [eventId, draftId]);
      return saved[0];
    });
  }
}
