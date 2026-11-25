import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError, invalid } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import { getDatabasePool } from "../../shared/db/pool";
import { prepareNewExpense } from "../services/confirmationValidation";
import { parseDraftVersion } from "../services/draftValidation";
import type { Draft, DraftConfirmation, DraftConfirmer } from "../types";
import { selectDraft } from "./draftReader";
import { withContractEvent } from "./eventTransaction";

const changed = () => new ApiError(409, "DRAFT_CHANGED", "This draft changed. Reload it before confirming.");
const documentUnavailable = () => new ApiError(409, "DOCUMENT_UNVERIFIED", "Reopen the source document to verify this draft before confirming.");

export class MySqlDraftConfirmer implements DraftConfirmer {
  constructor(private readonly connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection()) {}

  async confirm(eventId: string, draftId: string, sub: string, body: unknown): Promise<DraftConfirmation> {
    parseId(eventId, "eventId", true); parseId(draftId, "draftId", true);
    if (typeof sub !== "string" || !sub || sub.trim() !== sub || sub.length > 128) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const { version } = parseDraftVersion(body);
    // Serialize confirmations with other contract mutations before taking any child locks.
    return withContractEvent(this.connect, eventId, sub, true, async connection => {
      const load = async () => {
        const [rows] = await connection.execute<(RowDataPacket & Draft)[]>(
          selectDraft + " WHERE d.event_id = ? AND d.draft_id = ? LIMIT 1", [eventId, draftId]);
        if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
        return rows[0];
      };
      const before = await load();
      // A retry must never recreate an expense, including after its later deletion.
      if (before.status === "CONFIRMED") {
        if (!before.confirmedExpenseId) throw new ApiError(409, "CONFIRMATION_UNAVAILABLE", "This draft has already been confirmed. Review its expense history.");
        return { draft: before, created: false };
      }
      const editable = (row: Pick<Draft, "version" | "status">) => {
        if (row.status !== "DRAFT") throw new ApiError(409, "DRAFT_NOT_EDITABLE", "Only an open draft can be confirmed.");
        if (row.version !== version) throw changed();
      };
      editable(before);
      if (before.confirmedExpenseId) throw new ApiError(409, "CONFIRMATION_UNAVAILABLE", "Review this draft's existing expense history before continuing.");
      const input = prepareNewExpense(before);
      if (!before.documentId) throw documentUnavailable();

      // Referenced parents precede the draft lock, matching deletion and draft editing.
      const [documents] = await connection.execute<RowDataPacket[]>(
        "SELECT content_sha256 AS fingerprint FROM event_documents WHERE event_id = ? AND document_id = ? FOR SHARE",
        [eventId, before.documentId]);
      const fingerprint = documents[0]?.fingerprint;
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) throw documentUnavailable();
      if (input.vendorId !== null) {
        const [vendors] = await connection.execute<RowDataPacket[]>(
          "SELECT vendor_id FROM vendors WHERE event_id = ? AND vendor_id = ? FOR SHARE", [eventId, input.vendorId]);
        if (!vendors.length) invalid("vendorId", "Choose a vendor from this event.");
      }
      const [categories] = await connection.execute<RowDataPacket[]>(
        "SELECT category_id FROM budget_categories WHERE event_id = ? AND category_id = ? FOR SHARE", [eventId, input.categoryId]);
      if (!categories.length) invalid("categoryId", "Choose a category from this event.");
      const [locked] = await connection.execute<(RowDataPacket & Pick<Draft, "status" | "version" | "documentId" | "categoryId" | "vendorId" | "targetExpenseId"> & { fingerprint: string | null })[]>(
        "SELECT status, CAST(version AS CHAR) AS version, CAST(document_id AS CHAR) AS documentId, " +
        "CAST(category_id AS CHAR) AS categoryId, CAST(vendor_id AS CHAR) AS vendorId, " +
        "CAST(target_expense_id AS CHAR) AS targetExpenseId, content_sha256 AS fingerprint " +
        "FROM draft_budget_items WHERE event_id = ? AND draft_id = ? FOR UPDATE", [eventId, draftId]);
      const current = locked[0];
      if (!current) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
      editable(current);
      for (const field of ["documentId", "categoryId", "vendorId", "targetExpenseId"] as const) {
        if (current[field] !== before[field]) throw changed();
      }
      if (current.fingerprint !== fingerprint) throw documentUnavailable();
      if (version === "18446744073709551615") throw new ApiError(409, "DRAFT_VERSION_LIMIT", "This draft cannot be changed further.");

      await connection.execute(
        "INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount, due_date) VALUES (?, ?, ?, ?, ?, ?)",
        [eventId, input.categoryId, input.vendorId, input.description, input.committedAmount, input.dueDate]);
      // mysql2's numeric insertId cannot represent all unsigned BIGINT identifiers.
      const [[ids]] = await connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
      const expenseId = String(ids.id);
      const [saved] = await connection.execute<ResultSetHeader>(
        "UPDATE draft_budget_items SET status = 'CONFIRMED', confirmed_expense_id = ?, reviewed_by_sub = ?, " +
        "updated_by_sub = ?, confirmed_at = UTC_TIMESTAMP(6), version = version + 1 " +
        "WHERE event_id = ? AND draft_id = ? AND status = 'DRAFT' AND version = ?",
        [expenseId, sub, sub, eventId, draftId, version]);
      if (saved.affectedRows !== 1) throw changed();
      // Manual confirmation supersedes any pending extraction; no payment is inserted.
      await connection.execute(
        "UPDATE contract_extraction_jobs SET status = 'CANCELLED', completed_at = UTC_TIMESTAMP(6) " +
        "WHERE event_id = ? AND draft_id = ? AND status IN ('QUEUED','PROCESSING')", [eventId, draftId]);
      return { draft: await load(), created: true };
    });
  }
}
