import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError, invalid } from "../../expense-service/errors";
import { cents, parseId } from "../../expense-service/services/validation";
import { getDatabasePool } from "../../shared/db/pool";
import { prepareExistingExpense, prepareNewExpense, prepareNewVendor } from "../services/confirmationValidation";
import { parseDraftConfirmation } from "../services/draftValidation";
import type { ExpenseInput } from "../../expense-service/types";
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
    const { version, expectedExpense, createVendor = false } = parseDraftConfirmation(body);
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
      const updating = before.saveAction === "UPDATE_EXPENSE";
      const input = updating ? prepareExistingExpense(before, createVendor) : prepareNewExpense(before, createVendor);
      if (updating && !expectedExpense) invalid("expectedExpense", "Reload and review the selected expense before confirming.");
      if (!updating && expectedExpense) invalid("expectedExpense", "An expense snapshot is only used when updating an existing expense.");
      if (updating) {
        // Payments, ordinary expense edits and Update both all lock this parent first.
        const [targets] = await connection.execute<(RowDataPacket & ExpenseInput)[]>(
          "SELECT CAST(category_id AS CHAR) AS categoryId, CAST(vendor_id AS CHAR) AS vendorId, " +
          "description, committed_amount AS committedAmount, due_date AS dueDate " +
          "FROM expenses WHERE event_id = ? AND expense_id = ? FOR UPDATE", [eventId, before.targetExpenseId]);
        const target = targets[0];
        if (!target) invalid("targetExpenseId", "Choose an expense from this event.");
        if (Object.entries(expectedExpense!).some(([field, value]) => target[field] !== value)) {
          throw new ApiError(409, "EXPENSE_CHANGED", "The selected expense changed. Reload and review it before confirming.");
        }
        if (target.vendorId !== null && target.vendorId !== input.vendorId) {
          invalid("vendorId", "Keep the vendor linked to the selected expense.");
        }
        const [[payments]] = await connection.execute<RowDataPacket[]>(
          "SELECT COALESCE(SUM(CASE WHEN payment_type = 'REFUND' THEN -amount ELSE amount END), 0.00) AS paid " +
          "FROM expense_payments WHERE expense_id = ?", [before.targetExpenseId]);
        const paid = cents(String(payments.paid));
        if (paid < 0n || paid > cents(target.committedAmount)) throw new ApiError(500, "INTERNAL_ERROR", "Invalid stored payment totals.");
        if (cents(input.committedAmount) < paid) {
          throw new ApiError(409, "AMOUNT_BELOW_PAID", "Contract total cannot be less than the amount already paid.",
            { totalAmount: "The contract total cannot be less than the amount already paid." });
        }
      }
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
        "SELECT category_id, name FROM budget_categories WHERE event_id = ? AND category_id = ? FOR SHARE", [eventId, input.categoryId]);
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

      if (createVendor) {
        const vendor = prepareNewVendor(before, String(categories[0].name));
        // Match case/spacing using the existing vendor-name database collation.
        // The event lock serializes these checks across contract confirmations.
        const [existing] = await connection.execute<RowDataPacket[]>(
          "SELECT vendor_id FROM vendors WHERE event_id = ? AND TRIM(name) = ? LIMIT 1", [eventId, vendor.name]);
        if (existing.length) {
          throw new ApiError(409, "VENDOR_ALREADY_EXISTS", "A vendor with this business name already exists in this event. Select that vendor instead.",
            { vendorName: "Select the existing vendor instead of creating another." });
        }
        await connection.execute(
          "INSERT INTO vendors (event_id, name, category, booking_status, contract_status) VALUES (?, ?, ?, ?, ?)",
          [eventId, vendor.name, vendor.category, vendor.bookingStatus, vendor.contractStatus]);
        const [[ids]] = await connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
        input.vendorId = String(ids.id);
      }

      let expenseId: string;
      if (updating) {
        expenseId = before.targetExpenseId!;
        await connection.execute(
          "UPDATE expenses SET category_id = ?, vendor_id = ?, description = ?, committed_amount = ?, due_date = ? " +
          "WHERE event_id = ? AND expense_id = ?",
          [input.categoryId, input.vendorId, input.description, input.committedAmount, input.dueDate, eventId, expenseId]);
      } else {
        await connection.execute(
          "INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount, due_date) VALUES (?, ?, ?, ?, ?, ?)",
          [eventId, input.categoryId, input.vendorId, input.description, input.committedAmount, input.dueDate]);
        // mysql2's numeric insertId cannot represent all unsigned BIGINT identifiers.
        const [[ids]] = await connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
        expenseId = String(ids.id);
      }
      const [saved] = await connection.execute<ResultSetHeader>(
        "UPDATE draft_budget_items SET status = 'CONFIRMED', vendor_id = ?, confirmed_expense_id = ?, reviewed_by_sub = ?, " +
        "updated_by_sub = ?, confirmed_at = UTC_TIMESTAMP(6), version = version + 1 " +
        "WHERE event_id = ? AND draft_id = ? AND status = 'DRAFT' AND version = ?",
        [input.vendorId, expenseId, sub, sub, eventId, draftId, version]);
      if (saved.affectedRows !== 1) throw changed();
      // Manual confirmation supersedes any pending extraction; no payment is inserted.
      await connection.execute(
        "UPDATE contract_extraction_jobs SET status = 'CANCELLED', completed_at = UTC_TIMESTAMP(6) " +
        "WHERE event_id = ? AND draft_id = ? AND status IN ('QUEUED','PROCESSING')", [eventId, draftId]);
      return { draft: await load(), created: !updating };
    });
  }
}
