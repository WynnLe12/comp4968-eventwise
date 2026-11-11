import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getDatabasePool } from "../../shared/db/pool";
import { ApiError, invalid } from "../errors";
import type { ExpenseInput, ExpenseQuery, ExpenseRepository, ExpenseRow, ExpenseTransaction, Payment, PaymentInput, PaymentQuery } from "../types";

type Row = RowDataPacket & ExpenseRow;
const joins = `FROM expenses e
 JOIN budget_categories c ON c.category_id = e.category_id AND c.event_id = e.event_id
 LEFT JOIN vendors v ON v.vendor_id = e.vendor_id AND v.event_id = e.event_id
 LEFT JOIN (SELECT expense_id, SUM(CASE WHEN payment_type = 'REFUND' THEN -amount ELSE amount END) AS net_paid
 FROM expense_payments GROUP BY expense_id) p ON p.expense_id = e.expense_id`;
const columns = `CAST(e.expense_id AS CHAR) AS expenseId, CAST(e.event_id AS CHAR) AS eventId,
 CAST(e.category_id AS CHAR) AS categoryId, CAST(e.vendor_id AS CHAR) AS vendorId,
 c.name AS categoryName, v.name AS vendorName, e.description,
 e.committed_amount AS committedAmount, e.due_date AS dueDate, COALESCE(p.net_paid, 0.00) AS paidTotal,
 DATE_FORMAT(e.created_at, '%Y-%m-%dT%H:%i:%sZ') AS createdAt,
 DATE_FORMAT(e.updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updatedAt`;

class MySqlExpenseTransaction implements ExpenseTransaction {
  constructor(private connection: PoolConnection) {}
  async assertMember(eventId: string, sub: string): Promise<void> {
    const [rows] = await this.connection.execute<RowDataPacket[]>(
      "SELECT member_id FROM event_members WHERE event_id = ? AND cognito_sub = ? AND role IN ('OWNER','CO_PLANNER') FOR SHARE", [eventId, sub]);
    if (!rows.length) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
  }
  async validateAssociations(eventId: string, input: ExpenseInput): Promise<void> {
    const [categories] = await this.connection.execute<RowDataPacket[]>(
      "SELECT category_id FROM budget_categories WHERE category_id = ? AND event_id = ? FOR SHARE", [input.categoryId, eventId]);
    if (!categories.length) invalid("categoryId", "Choose a category from this event.");
    if (input.vendorId !== null) {
      const [vendors] = await this.connection.execute<RowDataPacket[]>(
        "SELECT vendor_id FROM vendors WHERE vendor_id = ? AND event_id = ? FOR SHARE", [input.vendorId, eventId]);
      if (!vendors.length) invalid("vendorId", "Choose a vendor from this event.");
    }
  }
  async find(eventId: string, expenseId: string, lock = false): Promise<ExpenseRow | null> {
    if (lock) {
      const [rows] = await this.connection.execute<RowDataPacket[]>(
        "SELECT expense_id FROM expenses WHERE event_id = ? AND expense_id = ? FOR UPDATE", [eventId, expenseId]);
      if (!rows.length) return null;
    }
    const [rows] = await this.connection.execute<Row[]>(`SELECT ${columns} ${joins} WHERE e.event_id = ? AND e.expense_id = ?`, [eventId, expenseId]);
    return rows[0] ?? null;
  }
  async list(eventId: string, query: ExpenseQuery, today: string): Promise<{ rows: ExpenseRow[]; total: number }> {
    const predicates = ["e.event_id = ?"];
    const values: (string | number)[] = [eventId];
    for (const key of ["categoryId", "vendorId"] as const) {
      if (query[key]) {
        predicates.push(`e.${key === "categoryId" ? "category_id" : "vendor_id"} = ?`);
        values.push(query[key]);
      }
    }
    if (query.paymentStatus) {
      predicates.push(`(CASE WHEN COALESCE(p.net_paid, 0) = e.committed_amount THEN 'PAID'
        WHEN COALESCE(p.net_paid, 0) = 0 THEN 'UNPAID' ELSE 'PARTIALLY_PAID' END) = ?`);
      values.push(query.paymentStatus);
    }
    if (query.overdue !== undefined) {
      const condition = "(e.due_date IS NOT NULL AND e.due_date < ? AND e.committed_amount > COALESCE(p.net_paid, 0))";
      predicates.push(query.overdue ? condition : `NOT ${condition}`);
      values.push(today);
    }
    if (query.q) {
      // LOCATE treats % and _ literally rather than as SQL LIKE wildcards.
      predicates.push("(LOCATE(LOWER(?), LOWER(e.description)) > 0 OR LOCATE(LOWER(?), LOWER(COALESCE(v.name, ''))) > 0)");
      values.push(query.q, query.q);
    }
    const where = `WHERE ${predicates.join(" AND ")}`;
    const [counts] = await this.connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total ${joins} ${where}`, values);
    const total = Number(counts[0]?.total ?? 0);
    if (!Number.isSafeInteger(total)) throw new ApiError(500, "INTERNAL_ERROR", "Result count exceeds supported range.");
    // Numeric pagination values were validated by the route; query safely binds them.
    const [rows] = await this.connection.query<Row[]>(`SELECT ${columns} ${joins} ${where} ORDER BY e.expense_id DESC LIMIT ? OFFSET ?`, [...values, query.limit, query.offset]);
    return { rows, total };
  }
  async create(eventId: string, input: ExpenseInput): Promise<string> {
    await this.connection.execute(
      "INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount, due_date) VALUES (?, ?, ?, ?, ?, ?)",
      [eventId, input.categoryId, input.vendorId, input.description, input.committedAmount, input.dueDate]);
    // Avoid the numeric insertId representation for unsigned BIGINT keys.
    const [rows] = await this.connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    return String(rows[0]!.id);
  }
  async update(eventId: string, expenseId: string, input: ExpenseInput): Promise<void> {
    await this.connection.execute(
      "UPDATE expenses SET category_id = ?, vendor_id = ?, description = ?, committed_amount = ?, due_date = ? WHERE event_id = ? AND expense_id = ?",
      [input.categoryId, input.vendorId, input.description, input.committedAmount, input.dueDate, eventId, expenseId]);
  }
  async listPayments(eventId: string, expenseId: string, query: PaymentQuery): Promise<{ rows: Payment[]; total: number }> {
    const scope = "FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id WHERE e.event_id = ? AND e.expense_id = ?";
    const [counts] = await this.connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total ${scope}`, [eventId, expenseId]);
    const total = Number(counts[0]?.total ?? 0);
    if (!Number.isSafeInteger(total)) throw new ApiError(500, "INTERNAL_ERROR", "Result count exceeds supported range.");
    const [rows] = await this.connection.query<(RowDataPacket & Payment)[]>(
      `SELECT CAST(p.payment_id AS CHAR) AS paymentId, CAST(p.expense_id AS CHAR) AS expenseId,
       p.amount, p.paid_at AS paidAt, p.payment_type AS paymentType, p.notes,
       DATE_FORMAT(p.created_at, '%Y-%m-%dT%H:%i:%sZ') AS createdAt ${scope}
       ORDER BY p.paid_at DESC, p.payment_id DESC LIMIT ? OFFSET ?`,
      [eventId, expenseId, query.limit, query.offset]);
    return { rows, total };
  }
  async createPayment(eventId: string, expenseId: string, input: PaymentInput): Promise<Payment> {
    // Caller holds the parent expense lock. Scope the INSERT itself as defense in depth.
    const [inserted] = await this.connection.execute<ResultSetHeader>(
      `INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type, notes)
       SELECT expense_id, ?, ?, ?, ? FROM expenses WHERE event_id = ? AND expense_id = ?`,
      [input.amount, input.paidAt, input.paymentType, input.notes, eventId, expenseId]);
    if (inserted.affectedRows !== 1) throw new ApiError(404, "NOT_FOUND", "Expense not found.");
    const [ids] = await this.connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    const paymentId = String(ids[0]!.id);
    const [rows] = await this.connection.execute<(RowDataPacket & Payment)[]>(
      `SELECT CAST(p.payment_id AS CHAR) AS paymentId, CAST(p.expense_id AS CHAR) AS expenseId,
       p.amount, p.paid_at AS paidAt, p.payment_type AS paymentType, p.notes,
       DATE_FORMAT(p.created_at, '%Y-%m-%dT%H:%i:%sZ') AS createdAt
       FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id
       WHERE e.event_id = ? AND e.expense_id = ? AND p.payment_id = ?`, [eventId, expenseId, paymentId]);
    const payment = rows[0];
    if (!payment) throw new ApiError(500, "INTERNAL_ERROR", "Unable to record payment.");
    await this.connection.execute("UPDATE expenses SET updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND expense_id = ?", [eventId, expenseId]);
    return payment;
  }
  async remove(eventId: string, expenseId: string): Promise<void> {
    await this.connection.execute("DELETE FROM expenses WHERE event_id = ? AND expense_id = ?", [eventId, expenseId]);
  }
}

export class MySqlExpenseRepository implements ExpenseRepository {
  constructor(private pool: () => Pool = getDatabasePool) {}
  async transaction<T>(work: (tx: ExpenseTransaction) => Promise<T>): Promise<T> {
    let connection: PoolConnection | undefined;
    try {
      connection = await this.pool().getConnection();
      await connection.query("SET time_zone = '+00:00'");
      await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await connection.beginTransaction();
      const result = await work(new MySqlExpenseTransaction(connection));
      await connection.commit();
      return result;
    } catch (error) {
      if (connection) await connection.rollback().catch(() => undefined);
      if (error instanceof ApiError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "DB_CONFIG_ERROR";
      // Codes only: never log credentials, query text, or raw driver messages.
      console.error("Expense database operation failed:", code);
      if (["ER_NO_REFERENCED_ROW_2", "ER_ROW_IS_REFERENCED_2"].includes(code)) {
        throw new ApiError(422, "VALIDATION_ERROR", "Related records changed; refresh and try again.");
      }
      const unavailable = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST", "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "DB_CONFIG_ERROR"].includes(code);
      throw new ApiError(unavailable ? 503 : 500, unavailable ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR",
        unavailable ? "Database temporarily unavailable." : "Unable to complete the request.");
    } finally { connection?.release(); }
  }
}
