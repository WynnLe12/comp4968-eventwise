// RDS queries for the event dashboard (Feature 10). See docs/api/dashboard.md.
// Budget totals come from the expense summary; this file covers event access,
// upcoming payments and task progress.

import type { Pool, RowDataPacket } from "mysql2/promise";
import { db } from "../../shared/db/db";

/** Most items returned in the payments and tasks lists. Inlined in SQL (not user input). */
export const DASHBOARD_LIST_LIMIT = 5;

export type MemberRole = "OWNER" | "CO_PLANNER";

export interface PaymentItemRow {
  expenseId: string;
  description: string;
  vendorName: string | null;
  categoryName: string;
  dueDate: string;
  outstandingAmount: string;
  isOverdue: boolean;
}

export interface PaymentRows {
  overdueTotal: string;
  overdueCount: number;
  upcomingTotal: string;
  upcomingCount: number;
  items: PaymentItemRow[];
}

export interface TaskItemRow {
  taskId: string;
  title: string;
  dueDate: string;
  assigneeDisplayName: string | null;
  assigneeRole: MemberRole | null;
}

export interface TaskRows {
  total: number;
  completed: number;
  overdue: number;
  nextDue: TaskItemRow[];
}

/** mysql2 returns counts as strings here (bigNumberStrings), so convert them carefully. */
function count(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid dashboard count");
  return number;
}

// Net paid per expense (refunds subtract), then the balance still owed. Same rules as
// the expense summary in docs/api/expenses.md section 6.
const OPEN_EXPENSES = `
  WITH paid AS (
    SELECT p.expense_id,
      SUM(CASE WHEN p.payment_type = 'REFUND' THEN -p.amount ELSE p.amount END) AS net_paid
    FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id
    WHERE e.event_id = ?
    GROUP BY p.expense_id
  ), open_expenses AS (
    SELECT e.expense_id, e.description, e.due_date, c.name AS category_name, v.name AS vendor_name,
      e.committed_amount - COALESCE(paid.net_paid, 0.00) AS outstanding
    FROM expenses e
    JOIN budget_categories c ON c.category_id = e.category_id AND c.event_id = e.event_id
    LEFT JOIN vendors v ON v.vendor_id = e.vendor_id AND v.event_id = e.event_id
    LEFT JOIN paid ON paid.expense_id = e.expense_id
    WHERE e.event_id = ? AND e.due_date IS NOT NULL AND e.due_date <= ?
      AND e.committed_amount - COALESCE(paid.net_paid, 0.00) > 0
  )`;

export class DashboardRepository {
  constructor(private readonly pool: Pick<Pool, "execute"> = db) {}

  /**
   * The caller's role in the event: undefined when the event does not exist,
   * null when it exists but the caller is not a member.
   */
  async eventAccess(eventId: string, cognitoSub: string): Promise<MemberRole | null | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT m.role FROM events e
       LEFT JOIN event_members m ON m.event_id = e.event_id AND m.cognito_sub = ?
       WHERE e.event_id = ?`,
      [cognitoSub, eventId],
    );
    if (!rows.length) return undefined;
    return (rows[0]!.role as MemberRole | null) ?? null;
  }

  /**
   * Expenses still owed with a due date up to `until`: overdue ones (due before `today`)
   * and upcoming ones (due from `today` to `until`). Dates are YYYY-MM-DD (UTC).
   */
  async payments(eventId: string, today: string, until: string): Promise<PaymentRows> {
    const params = [eventId, eventId, until];
    const [totals] = await this.pool.execute<RowDataPacket[]>(
      `${OPEN_EXPENSES}
       SELECT
         CAST(COALESCE(SUM(CASE WHEN due_date < ? THEN outstanding END), 0.00) AS CHAR) AS overdueTotal,
         COUNT(CASE WHEN due_date < ? THEN 1 END) AS overdueCount,
         CAST(COALESCE(SUM(CASE WHEN due_date >= ? THEN outstanding END), 0.00) AS CHAR) AS upcomingTotal,
         COUNT(CASE WHEN due_date >= ? THEN 1 END) AS upcomingCount
       FROM open_expenses`,
      [...params, today, today, today, today],
    );
    // Nearest due date first, so overdue items come before upcoming ones.
    const [items] = await this.pool.execute<RowDataPacket[]>(
      `${OPEN_EXPENSES}
       SELECT CAST(expense_id AS CHAR) AS expenseId, description, vendor_name AS vendorName,
         category_name AS categoryName, DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate,
         CAST(outstanding AS CHAR) AS outstandingAmount, due_date < ? AS isOverdue
       FROM open_expenses
       ORDER BY due_date, expense_id
       LIMIT ${DASHBOARD_LIST_LIMIT}`,
      [...params, today],
    );
    const row = totals[0] ?? {};
    return {
      overdueTotal: String(row.overdueTotal ?? "0.00"),
      overdueCount: count(row.overdueCount),
      upcomingTotal: String(row.upcomingTotal ?? "0.00"),
      upcomingCount: count(row.upcomingCount),
      items: items.map((item) => ({
        expenseId: String(item.expenseId),
        description: String(item.description),
        vendorName: item.vendorName === null ? null : String(item.vendorName),
        categoryName: String(item.categoryName),
        dueDate: String(item.dueDate),
        outstandingAmount: String(item.outstandingAmount),
        isOverdue: Number(item.isOverdue) === 1,
      })),
    };
  }

  /**
   * Task progress (Feature 12 `tasks` table). Overdue = not completed and due before
   * `today`. `nextDue` lists open tasks with a due date, nearest first.
   */
  async tasks(eventId: string, today: string): Promise<TaskRows> {
    const [totals] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
         COUNT(CASE WHEN is_completed THEN 1 END) AS completed,
         COUNT(CASE WHEN NOT is_completed AND due_date < ? THEN 1 END) AS overdue
       FROM tasks WHERE event_id = ?`,
      [today, eventId],
    );
    // The assignee must belong to the same event; a removed assignee is NULL.
    const [items] = await this.pool.execute<RowDataPacket[]>(
      `SELECT CAST(t.task_id AS CHAR) AS taskId, t.title, DATE_FORMAT(t.due_date, '%Y-%m-%d') AS dueDate,
         m.display_name AS assigneeDisplayName, m.role AS assigneeRole
       FROM tasks t
       LEFT JOIN event_members m ON m.member_id = t.assigned_member_id AND m.event_id = t.event_id
       WHERE t.event_id = ? AND NOT t.is_completed AND t.due_date IS NOT NULL
       ORDER BY t.due_date, t.task_id
       LIMIT ${DASHBOARD_LIST_LIMIT}`,
      [eventId],
    );
    const row = totals[0] ?? {};
    return {
      total: count(row.total),
      completed: count(row.completed),
      overdue: count(row.overdue),
      nextDue: items.map((item) => ({
        taskId: String(item.taskId),
        title: String(item.title),
        dueDate: String(item.dueDate),
        assigneeDisplayName: item.assigneeDisplayName === null ? null : String(item.assigneeDisplayName),
        assigneeRole: (item.assigneeRole as MemberRole | null) ?? null,
      })),
    };
  }
}
