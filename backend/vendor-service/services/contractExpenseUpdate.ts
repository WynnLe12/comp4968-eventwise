import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { cents } from "../../expense-service/services/validation";
import { idParam } from "../../shared/http/routes";
import { getDatabasePool } from "../../shared/db/pool";
import { EDITABLE_FIELDS } from "../types";
import * as repo from "../repositories/vendorRepository";
import { prepareVendor } from "./prepareVendor";
import { editableFields, toVendor } from "./vendorMapper";

interface LinkedExpense extends RowDataPacket {
  expense_id: string; vendor_id: string | null; committed_amount: string;
}
const conflict = () => new ApiError(409, "CONTRACT_EXPENSE_CHANGED", "The contract or linked expenses changed. Cancel and reopen the vendor before trying again.");
function money(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/.test(value);
}

/** One connection and one commit for the explicit Update both choice. */
export function createContractExpenseUpdater(connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection()) {
  return async (eventId: string, vendorId: string | null, sub: string, body: unknown) => {
    if (!sub || idParam(eventId) === null) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
    if (vendorId === null) throw new ApiError(404, "NOT_FOUND", "Vendor not found.");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(422, "VALIDATION_ERROR", "Provide contract update details.");
    const input = body as Record<string, unknown>;
    const allowed = ["expenseId", "expectedContractTotal", "expectedExpenseTotal", "vendorChanges"];
    if (Object.keys(input).some(key => !allowed.includes(key)) ||
        typeof input.expenseId !== "string" || idParam(input.expenseId) === null ||
        !(input.expectedContractTotal === null || money(input.expectedContractTotal)) || !money(input.expectedExpenseTotal) ||
        !input.vendorChanges || typeof input.vendorChanges !== "object" || Array.isArray(input.vendorChanges)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Provide valid contract and expense update details.");
    }
    const changes = input.vendorChanges as Record<string, unknown>;
    if (!Object.hasOwn(changes, "contractTotal") || changes.contractTotal === null ||
        Object.keys(changes).some(key => !(EDITABLE_FIELDS as readonly string[]).includes(key))) {
      throw new ApiError(422, "VALIDATION_ERROR", "Provide only editable vendor fields and a contract total.");
    }
    const connection = await connect();
    try {
      await connection.beginTransaction();
      const [members] = await connection.execute<RowDataPacket[]>(
        "SELECT 1 FROM event_members WHERE event_id = ? AND cognito_sub = ? LIMIT 1 FOR SHARE", [eventId, sub]);
      if (!members.length) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
      // Match the parent-row lock used by payments and ordinary expense updates.
      const [expenses] = await connection.execute<LinkedExpense[]>(
        "SELECT expense_id, vendor_id, committed_amount FROM expenses WHERE expense_id = ? AND event_id = ? FOR UPDATE",
        [input.expenseId, eventId]);
      const expense = expenses[0];
      if (!expense || expense.vendor_id !== vendorId) throw new ApiError(404, "NOT_FOUND", "Linked expense not found.");
      const [lockedVendors] = await connection.execute<RowDataPacket[]>(
        "SELECT vendor_id FROM vendors WHERE vendor_id = ? AND event_id = ? FOR UPDATE", [vendorId, eventId]);
      if (!lockedVendors.length) throw new ApiError(404, "NOT_FOUND", "Vendor not found.");
      const currentRow = await repo.findVendor(eventId, vendorId, connection);
      if (!currentRow) throw new ApiError(404, "NOT_FOUND", "Vendor not found.");
      const current = toVendor(currentRow);
      const [linked] = await connection.execute<RowDataPacket[]>(
        "SELECT expense_id FROM expenses WHERE vendor_id = ? AND event_id = ? FOR UPDATE", [vendorId, eventId]);
      // The vendor lock blocks new associations while checking the linked list.
      if (linked.length !== 1 || String(linked[0]!.expense_id) !== input.expenseId ||
          current.contractTotal !== input.expectedContractTotal || expense.committed_amount !== input.expectedExpenseTotal) throw conflict();
      const prepared = prepareVendor(editableFields(current), changes);
      if (!prepared.ok) throw new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", prepared.fields as Record<string, string>);
      if (prepared.vendor.contractTotal === null) throw new ApiError(422, "VALIDATION_ERROR", "A contract total is required.");
      const [payments] = await connection.execute<RowDataPacket[]>(
        "SELECT COALESCE(SUM(CASE WHEN payment_type = 'REFUND' THEN -amount ELSE amount END), 0.00) AS paid FROM expense_payments WHERE expense_id = ?",
        [input.expenseId]);
      const paid = cents(String(payments[0]?.paid ?? "0.00"));
      if (paid < 0n || paid > cents(expense.committed_amount)) throw new ApiError(500, "INTERNAL_ERROR", "Invalid stored payment totals.");
      if (cents(prepared.vendor.contractTotal) < paid) {
        throw new ApiError(409, "AMOUNT_BELOW_PAID", "Contract total cannot be less than the amount already paid.");
      }
      await repo.updateVendor(eventId, vendorId, prepared.vendor, connection);
      // Keep category, description, due date, vendor association and payment history.
      await connection.execute(
        "UPDATE expenses SET committed_amount = ? WHERE expense_id = ? AND event_id = ? AND vendor_id = ?",
        [prepared.vendor.contractTotal, input.expenseId, eventId, vendorId]);
      const updated = await repo.findVendor(eventId, vendorId, connection);
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Vendor not found.");
      const result = toVendor(updated);
      await connection.commit();
      return result;
    } catch (failure) {
      await connection.rollback();
      throw failure;
    } finally {
      connection.release();
    }
  };
}
export const updateContractExpense = createContractExpenseUpdater();
