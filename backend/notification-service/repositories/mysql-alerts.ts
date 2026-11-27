import type { Pool, RowDataPacket } from "mysql2/promise";
import { getDatabasePool } from "../../shared/db/pool";
import type {
  AlertCandidateKey,
  AlertRepository,
  BudgetOverrunRow,
  DuePaymentRow,
  SentAlertRecord,
} from "../types";

export function alertIdentityKey(candidate: AlertCandidateKey): string {
  return `${candidate.eventId}|${candidate.alertType}|${candidate.entityId}|${candidate.dedupeKey}`;
}

export class MySqlAlertRepository implements AlertRepository {
  constructor(private pool: () => Pool = getDatabasePool) {}

  async findDuePayments(startDate: string, endDate: string): Promise<DuePaymentRow[]> {
    const [rows] = await this.pool().execute<(RowDataPacket & DuePaymentRow)[]>(
      `WITH payment_totals AS (
         SELECT expense_id,
           SUM(CASE WHEN payment_type = 'REFUND' THEN -amount ELSE amount END) AS net_paid
         FROM expense_payments
         GROUP BY expense_id
       )
       SELECT
         CAST(ev.event_id AS CHAR) AS eventId,
         ev.name AS eventName,
         m.cognito_sub AS ownerSub,
         m.display_name AS ownerDisplayName,
         CAST(e.expense_id AS CHAR) AS expenseId,
         e.description AS description,
         c.name AS categoryName,
         v.name AS vendorName,
         e.due_date AS dueDate,
         e.committed_amount AS committedAmount,
         COALESCE(p.net_paid, 0.00) AS paidTotal
       FROM expenses e
       JOIN events ev ON ev.event_id = e.event_id
       JOIN event_members m ON m.event_id = ev.event_id AND m.role = 'OWNER'
       JOIN budget_categories c ON c.category_id = e.category_id AND c.event_id = e.event_id
       LEFT JOIN vendors v ON v.vendor_id = e.vendor_id AND v.event_id = e.event_id
       LEFT JOIN payment_totals p ON p.expense_id = e.expense_id
       WHERE e.due_date IS NOT NULL
         AND e.due_date >= ?
         AND e.due_date <= ?
         AND e.committed_amount > COALESCE(p.net_paid, 0.00)
       ORDER BY ev.event_id ASC, e.due_date ASC, e.expense_id ASC`,
      [startDate, endDate],
    );
    return rows;
  }

  async findBudgetOverruns(): Promise<BudgetOverrunRow[]> {
    const [rows] = await this.pool().execute<(RowDataPacket & BudgetOverrunRow)[]>(
      `SELECT
         CAST(ev.event_id AS CHAR) AS eventId,
         ev.name AS eventName,
         m.cognito_sub AS ownerSub,
         m.display_name AS ownerDisplayName,
         CAST(c.category_id AS CHAR) AS categoryId,
         c.name AS categoryName,
         c.planned_amount AS plannedAmount,
         COALESCE(SUM(e.committed_amount), 0.00) AS committedTotal
       FROM budget_categories c
       JOIN events ev ON ev.event_id = c.event_id
       JOIN event_members m ON m.event_id = ev.event_id AND m.role = 'OWNER'
       LEFT JOIN expenses e ON e.category_id = c.category_id AND e.event_id = c.event_id
       GROUP BY ev.event_id, ev.name, m.cognito_sub, m.display_name, c.category_id, c.name, c.planned_amount, c.sort_order
       HAVING COALESCE(SUM(e.committed_amount), 0.00) > c.planned_amount
       ORDER BY ev.event_id ASC, c.sort_order ASC, c.category_id ASC`,
    );
    return rows;
  }

  async findSentKeys(candidates: AlertCandidateKey[]): Promise<Set<string>> {
    const sent = new Set<string>();
    if (candidates.length === 0) return sent;

    const eventIds = Array.from(new Set(candidates.map(c => c.eventId)));
    const placeholders = eventIds.map(() => "?").join(", ");
    const [rows] = await this.pool().execute<(RowDataPacket & AlertCandidateKey)[]>(
      `SELECT
         CAST(event_id AS CHAR) AS eventId,
         alert_type AS alertType,
         CAST(entity_id AS CHAR) AS entityId,
         dedupe_key AS dedupeKey
       FROM alert_notifications
       WHERE event_id IN (${placeholders})`,
      eventIds,
    );

    for (const row of rows) {
      sent.add(alertIdentityKey(row));
    }
    return sent;
  }

  async recordSentAlerts(records: SentAlertRecord[]): Promise<void> {
    if (records.length === 0) return;

    const pool = this.pool();
    for (const record of records) {
      await pool.execute(
        `INSERT IGNORE INTO alert_notifications
           (event_id, owner_sub, alert_type, entity_id, dedupe_key, alert_date, details_snapshot, sns_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.eventId,
          record.ownerSub,
          record.alertType,
          record.entityId,
          record.dedupeKey,
          record.alertDate,
          record.detailsSnapshot.slice(0, 255),
          record.snsMessageId,
        ],
      );
    }
  }
}
