import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { db } from "../../shared/db/db";

export interface EventInput {
  name: string;
  template_id: string | null;
  event_date: string | null;
  venue: string | null;
  total_budget: string;
}

// Strings preserve BIGINT and DECIMAL precision; dates remain calendar dates.
export interface EventRecord extends EventInput {
  event_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface ListedEvent extends EventRecord {
  role: "OWNER" | "CO_PLANNER";
}

export interface EventWithMembership extends EventRecord {
  role: ListedEvent["role"] | null;
}

export class InvalidTemplateError extends Error { }
export class EventDeletionBlockedError extends Error {
  constructor(readonly reason: "payments" | "references") { super(reason); }
}

interface TemplateCategoryRow extends RowDataPacket {
  template_category_id: string;
  name: string;
  default_percentage: string;
  sort_order: number;
}

function allocateTemplateBudget(
  totalBudget: string,
  categories: TemplateCategoryRow[],
): string[] {
  if (!categories.length) return [];

  const [whole, fraction = ""] = totalBudget.split(".");
  const totalCents =
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));

  const percentageUnits = categories.map((category) => {
    const value = String(category.default_percentage);

    if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) {
      throw new InvalidTemplateError("Invalid template percentage");
    }

    const [integer, decimal = ""] = value.split(".");
    const units =
      BigInt(integer) * 100n +
      BigInt(decimal.padEnd(2, "0"));

    if (units > 10000n) {
      throw new InvalidTemplateError("Invalid template percentage");
    }

    return units;
  });

  const percentageTotal = percentageUnits.reduce(
    (sum, value) => sum + value,
    0n,
  );

  if (percentageTotal !== 10000n) {
    throw new InvalidTemplateError(
      "Template allocations must total 100%",
    );
  }

  const products = percentageUnits.map(
    (percentage) => totalCents * percentage,
  );

  const amounts = products.map(
    (product) => product / 10000n,
  );

  const allocated = amounts.reduce(
    (sum, amount) => sum + amount,
    0n,
  );

  const remaining = Number(totalCents - allocated);

  const order = products
    .map((product, index) => ({
      index,
      remainder: product % 10000n,
    }))
    .sort((a, b) => {
      if (a.remainder === b.remainder) {
        return a.index - b.index;
      }

      return a.remainder > b.remainder ? -1 : 1;
    });

  for (let index = 0; index < remaining; index++) {
    amounts[order[index].index] += 1n;
  }

  return amounts.map(
    (cents) =>
      `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`,
  );
}

export class EventRepository {
  constructor(private readonly pool: Pick<Pool, "getConnection"> = db) { }

  async delete(eventId: string, cognitoSub: string, authorize: (event: Pick<EventWithMembership, "role"> | undefined) => void): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [events] = await connection.execute<(RowDataPacket & Pick<EventWithMembership, "role">)[]>(
        `SELECT m.role FROM events e LEFT JOIN event_members m
         ON m.event_id = e.event_id AND m.cognito_sub = ? WHERE e.event_id = ? FOR UPDATE`, [cognitoSub, eventId],
      );
      authorize(events[0]);
      // Lock parents before checking references, preventing new FK references during deletion.
      await connection.execute("SELECT expense_id FROM expenses WHERE event_id = ? FOR UPDATE", [eventId]);
      await connection.execute("SELECT member_id FROM event_members WHERE event_id = ? FOR UPDATE", [eventId]);
      await connection.execute("SELECT document_id FROM event_documents WHERE event_id = ? FOR UPDATE", [eventId]);
      const [payments] = await connection.execute<RowDataPacket[]>(
        `SELECT p.payment_id FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id
         WHERE e.event_id = ? LIMIT 1 FOR UPDATE`, [eventId],
      );
      if (payments.length) throw new EventDeletionBlockedError("payments");
      const [tasks] = await connection.execute<RowDataPacket[]>(
        `SELECT t.task_id FROM tasks t JOIN event_members m ON m.member_id = t.assigned_member_id
         WHERE m.event_id = ? AND t.event_id <> ? LIMIT 1 FOR UPDATE`, [eventId, eventId],
      );
      const [drafts] = await connection.execute<RowDataPacket[]>(
        `SELECT b.draft_id FROM draft_budget_items b JOIN event_documents d ON d.document_id = b.document_id
         WHERE d.event_id = ? AND b.event_id <> ? LIMIT 1 FOR UPDATE`, [eventId, eventId],
      );
      if (tasks.length || drafts.length) throw new EventDeletionBlockedError("references");
      // RESTRICT links to vendors/categories require expenses to be removed first.
      await connection.execute("DELETE FROM expenses WHERE event_id = ?", [eventId]);
      const [result] = await connection.execute<ResultSetHeader>("DELETE FROM events WHERE event_id = ?", [eventId]);
      if (result.affectedRows !== 1) throw new Error("Event deletion was not completed");
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async update(
    eventId: string,
    patch: Partial<EventInput>,
    cognitoSub: string,
    authorize: (event: EventWithMembership | undefined) => void,
  ): Promise<EventWithMembership> {
    const connection = await this.pool.getConnection();
    const selectEvent = `SELECT CAST(e.event_id AS CHAR) AS event_id, CAST(e.template_id AS CHAR) AS template_id,
      e.name, DATE_FORMAT(e.event_date, '%Y-%m-%d') AS event_date, e.venue,
      CAST(e.total_budget AS CHAR) AS total_budget, e.created_at, e.updated_at, m.role
      FROM events e
      LEFT JOIN event_members m ON m.event_id = e.event_id AND m.cognito_sub = ?
      WHERE e.event_id = ?`;
    try {
      await connection.beginTransaction();
      const [current] = await connection.execute<(RowDataPacket & EventWithMembership)[]>(
        `${selectEvent} FOR UPDATE`, [cognitoSub, eventId],
      );
      // The service authorizes while the event and requesting membership are locked.
      authorize(current[0]);
      if (patch.template_id !== undefined && patch.template_id !== null) {
        const [templates] = await connection.execute<RowDataPacket[]>(
          "SELECT template_id FROM event_templates WHERE template_id = ? FOR SHARE", [patch.template_id],
        );
        if (!templates.length) throw new InvalidTemplateError("template_id does not exist");
      }
      // Column names come only from this fixed whitelist; values are always bound.
      const columns = (["name", "template_id", "event_date", "venue", "total_budget"] as const)
        .filter((column) => Object.hasOwn(patch, column));
      if (!columns.length) throw new Error("No supported update fields");
      const values = columns.map((column) => {
        const value = patch[column];
        if (value === undefined) throw new Error("Update values must be defined");
        return value;
      });
      await connection.execute(
        `UPDATE events SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE event_id = ?`,
        [...values, eventId],
      );
      const [updated] = await connection.execute<(RowDataPacket & EventWithMembership)[]>(
        selectEvent, [cognitoSub, eventId],
      );
      const event = updated[0];
      if (!event) throw new Error("Updated event could not be read");
      await connection.commit();
      return event;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getById(eventId: string, cognitoSub: string): Promise<EventWithMembership | undefined> {
    const connection = await this.pool.getConnection();
    try {
      // A left join distinguishes a missing event from an existing event without access.
      // Only the requesting user's membership can be joined.
      const [events] = await connection.execute<(RowDataPacket & EventWithMembership)[]>(
        `SELECT CAST(e.event_id AS CHAR) AS event_id, CAST(e.template_id AS CHAR) AS template_id,
          e.name, DATE_FORMAT(e.event_date, '%Y-%m-%d') AS event_date, e.venue,
          CAST(e.total_budget AS CHAR) AS total_budget, e.created_at, e.updated_at, m.role
         FROM events e
         LEFT JOIN event_members m ON m.event_id = e.event_id AND m.cognito_sub = ?
         WHERE e.event_id = ?`,
        [cognitoSub, eventId],
      );
      return events[0];
    } finally {
      connection.release();
    }
  }

  async list(cognitoSub: string): Promise<ListedEvent[]> {
    const connection = await this.pool.getConnection();
    try {
      const [events] = await connection.execute<(RowDataPacket & ListedEvent)[]>(
        `SELECT CAST(e.event_id AS CHAR) AS event_id, CAST(e.template_id AS CHAR) AS template_id,
          e.name, DATE_FORMAT(e.event_date, '%Y-%m-%d') AS event_date, e.venue,
          CAST(e.total_budget AS CHAR) AS total_budget, e.created_at, e.updated_at, m.role
         FROM events e
         INNER JOIN event_members m ON m.event_id = e.event_id
         WHERE m.cognito_sub = ?
         ORDER BY e.event_date IS NULL, e.event_date, e.event_id`,
        [cognitoSub],
      );
      return events;
    } finally {
      connection.release();
    }
  }

  async create(input: EventInput, cognitoSub: string): Promise<EventRecord> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (input.template_id !== null) {
        const [templates] = await connection.execute<RowDataPacket[]>(
          "SELECT template_id FROM event_templates WHERE template_id = ? FOR SHARE",
          [input.template_id],
        );
        if (templates.length === 0) throw new InvalidTemplateError("template_id does not exist");
      }
      await connection.execute(
        "INSERT INTO events (name, template_id, event_date, venue, total_budget) VALUES (?, ?, ?, ?, ?)",
        [input.name, input.template_id, input.event_date, input.venue, input.total_budget],
      );
      // Read the generated ID before inserting membership changes LAST_INSERT_ID().
      const [events] = await connection.execute<(RowDataPacket & EventRecord)[]>(
        `SELECT CAST(event_id AS CHAR) AS event_id, CAST(template_id AS CHAR) AS template_id,
          name, DATE_FORMAT(event_date, '%Y-%m-%d') AS event_date, venue,
          CAST(total_budget AS CHAR) AS total_budget, created_at, updated_at
         FROM events WHERE event_id = LAST_INSERT_ID()`,
      );
      const event = events[0];
      if (!event) throw new Error("Created event could not be read");

      await connection.execute(
        "INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER')",
        [event.event_id, cognitoSub],
      );

      // Initialize budget categories from the selected event template.
      if (input.template_id !== null) {
        const [templateCategories] =
          await connection.execute<TemplateCategoryRow[]>(
            `SELECT
         CAST(template_category_id AS CHAR) AS template_category_id,
         name,
         CAST(default_percentage AS CHAR) AS default_percentage,
         sort_order
       FROM template_budget_categories
       WHERE template_id = ?
       ORDER BY sort_order, template_category_id`,
            [input.template_id],
          );

        const plannedAmounts = allocateTemplateBudget(
          input.total_budget,
          templateCategories,
        );

        for (let index = 0; index < templateCategories.length; index++) {
          const category = templateCategories[index];

          await connection.execute(
            `INSERT INTO budget_categories
         (event_id, name, allocation_percentage, planned_amount, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
            [
              event.event_id,
              category.name,
              category.default_percentage,
              plannedAmounts[index],
              category.sort_order,
            ],
          );
        }
      }

      await connection.commit();

      return event;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
