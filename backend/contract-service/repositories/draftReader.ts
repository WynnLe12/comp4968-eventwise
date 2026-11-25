import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import { getDatabasePool } from "../../shared/db/pool";
import type { Draft, DraftPage, DraftQuery, DraftReader } from "../types";

// Explicit public fields: never return S3 keys, fingerprints, identities or raw OCR.
const selectDraft = `
  SELECT CAST(d.draft_id AS CHAR) AS draftId, CAST(d.event_id AS CHAR) AS eventId,
    CAST(doc.document_id AS CHAR) AS documentId,
    doc.original_filename AS documentFilename, doc.content_type AS documentContentType,
    d.description, CAST(d.category_id AS CHAR) AS categoryId,
    CAST(d.vendor_id AS CHAR) AS vendorId, d.vendor_name AS vendorName,
    d.total_amount AS totalAmount, d.deposit_amount AS depositAmount,
    d.due_date AS dueDate, d.currency_code AS currencyCode, d.save_action AS saveAction,
    CAST(d.target_expense_id AS CHAR) AS targetExpenseId,
    CAST(d.confirmed_expense_id AS CHAR) AS confirmedExpenseId,
    d.status, CAST(d.version AS CHAR) AS version,
    d.created_at AS createdAt, d.updated_at AS updatedAt, d.confirmed_at AS confirmedAt
  FROM draft_budget_items d
  LEFT JOIN event_documents doc ON doc.document_id = d.document_id AND doc.event_id = d.event_id
`;

export class MySqlDraftReader implements DraftReader {
  constructor(private readonly connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection()) {}

  private async read<T>(eventId: string, sub: string, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    parseId(eventId, "eventId", true);
    if (!sub || sub.trim() !== sub || sub.length > 128) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const connection = await this.connect();
    try {
      await connection.beginTransaction();
      // Hold membership until the read completes, including both pagination queries.
      const [members] = await connection.execute<RowDataPacket[]>(`
        SELECT role FROM event_members WHERE event_id = ?
          AND cognito_sub COLLATE utf8mb4_bin = ? AND role IN ('OWNER','CO_PLANNER') FOR SHARE
      `, [eventId, sub]);
      if (!members.length) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  list(eventId: string, sub: string, query: DraftQuery): Promise<DraftPage> {
    return this.read(eventId, sub, async connection => {
      const where = "d.event_id = ?" + (query.status ? " AND d.status = ?" : "");
      const values = query.status ? [eventId, query.status] : [eventId];
      const [counts] = await connection.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM draft_budget_items d WHERE ${where}`, values);
      const [rows] = await connection.execute<(RowDataPacket & Draft)[]>(
        selectDraft + ` WHERE ${where} ORDER BY d.updated_at DESC, d.draft_id DESC LIMIT ? OFFSET ?`,
        [...values, query.limit, query.offset]);
      return { data: rows, total: Number(counts[0].total), limit: query.limit, offset: query.offset };
    });
  }

  get(eventId: string, draftId: string, sub: string): Promise<Draft | null> {
    parseId(draftId, "draftId", true);
    return this.read(eventId, sub, async connection => {
      const [rows] = await connection.execute<(RowDataPacket & Draft)[]>(
        selectDraft + " WHERE d.event_id = ? AND d.draft_id = ? LIMIT 1", [eventId, draftId]);
      return rows[0] ?? null;
    });
  }
}
