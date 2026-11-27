import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError, invalid } from "../../expense-service/errors";
import { cents, parseId } from "../../expense-service/services/validation";
import { getDatabasePool } from "../../shared/db/pool";
import { parseDraftPatch } from "../services/draftValidation";
import type { Draft, DraftFields, DraftUpdater } from "../types";
import { selectDraft } from "./draftReader";
import { withContractEvent } from "./eventTransaction";

const columns: Record<keyof DraftFields, string> = {
  description: "description", categoryId: "category_id", vendorId: "vendor_id", vendorName: "vendor_name",
  totalAmount: "total_amount", depositAmount: "deposit_amount", dueDate: "due_date",
  currencyCode: "currency_code", saveAction: "save_action", targetExpenseId: "target_expense_id",
};
const changed = () => new ApiError(409, "DRAFT_CHANGED", "This draft changed. Reload it before saving.");

export class MySqlDraftUpdater implements DraftUpdater {
  constructor(private readonly connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection()) {}

  async update(eventId: string, draftId: string, sub: string, body: unknown): Promise<Draft> {
    parseId(eventId, "eventId", true); parseId(draftId, "draftId", true);
    if (typeof sub !== "string" || !sub || sub.trim() !== sub || sub.length > 128) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const patch = parseDraftPatch(body);
    return withContractEvent(this.connect, eventId, sub, false, async connection => {
      const [rows] = await connection.execute<(RowDataPacket & Draft)[]>(
        selectDraft + " WHERE d.event_id = ? AND d.draft_id = ? LIMIT 1", [eventId, draftId]);
      const before = rows[0];
      if (!before) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
      function editable(row: Pick<Draft, "status" | "version">) {
        if (row.status !== "DRAFT") throw new ApiError(409, "DRAFT_NOT_EDITABLE", "Only an open draft can be edited.");
        if (row.version !== patch.version) throw changed();
      }
      editable(before);
      const changes = patch.changes;
      if (changes.saveAction === "CREATE_EXPENSE" && !Object.hasOwn(changes, "targetExpenseId")) changes.targetExpenseId = null;
      const merged = { ...before, ...changes };
      if (merged.saveAction === "CREATE_EXPENSE" && merged.targetExpenseId !== null) {
        invalid("targetExpenseId", "Choose Update existing expense, or clear the expense selection.");
      }
      if (merged.totalAmount !== null && merged.depositAmount !== null && cents(merged.depositAmount) > cents(merged.totalAmount)) {
        invalid("depositAmount", "The deposit cannot exceed the contract total.");
      }
      // Lock referenced parents before the draft: FK deletion also locks parents first.
      if (merged.targetExpenseId !== null) {
        const [expenses] = await connection.execute<RowDataPacket[]>(
          "SELECT CAST(vendor_id AS CHAR) AS vendorId FROM expenses WHERE event_id = ? AND expense_id = ? FOR SHARE",
          [eventId, merged.targetExpenseId]);
        if (!expenses.length) invalid("targetExpenseId", "Choose an expense from this event.");
        if (merged.vendorId !== null && expenses[0].vendorId !== null && expenses[0].vendorId !== merged.vendorId) {
          invalid("vendorId", "Choose the vendor linked to the selected expense.");
        }
      }
      for (const [field, table, column] of [
        ["vendorId", "vendors", "vendor_id"], ["categoryId", "budget_categories", "category_id"],
      ] as const) {
        if (merged[field] === null) continue;
        const [parents] = await connection.execute<RowDataPacket[]>(
          `SELECT ${column} FROM ${table} WHERE event_id = ? AND ${column} = ? FOR SHARE`, [eventId, merged[field]]);
        if (!parents.length) invalid(field, "Choose a record from this event.");
      }
      const [locked] = await connection.execute<(RowDataPacket & Pick<Draft, "version" | "status" | "categoryId" | "vendorId" | "targetExpenseId">)[]>(`
        SELECT CAST(version AS CHAR) AS version, status, CAST(category_id AS CHAR) AS categoryId,
          CAST(vendor_id AS CHAR) AS vendorId, CAST(target_expense_id AS CHAR) AS targetExpenseId
        FROM draft_budget_items WHERE event_id = ? AND draft_id = ? FOR UPDATE
      `, [eventId, draftId]);
      if (!locked[0]) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
      editable(locked[0]);
      // SET NULL FK actions do not increment the version; reject changes during our read.
      for (const field of ["categoryId", "vendorId", "targetExpenseId"] as const) {
        if (locked[0][field] !== before[field]) throw changed();
      }
      if (locked[0].version === "18446744073709551615") {
        throw new ApiError(409, "DRAFT_VERSION_LIMIT", "This draft cannot be edited further.");
      }
      const fields = Object.keys(changes) as (keyof DraftFields)[];
      const values = fields.map(field => {
        const value = changes[field];
        if (value === undefined) throw new Error("Missing validated draft field.");
        return value;
      });
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE draft_budget_items SET " + fields.map(field => columns[field] + " = ?").join(", ") +
        ", updated_by_sub = ?, version = version + 1 WHERE event_id = ? AND draft_id = ? AND version = ? AND status = 'DRAFT'",
        [...values, sub, eventId, draftId, patch.version]);
      if (result.affectedRows !== 1) throw changed();
      const [updated] = await connection.execute<(RowDataPacket & Draft)[]>(
        selectDraft + " WHERE d.event_id = ? AND d.draft_id = ? LIMIT 1", [eventId, draftId]);
      return updated[0];
    });
  }
}
