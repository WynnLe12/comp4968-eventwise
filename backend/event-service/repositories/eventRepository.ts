import type { Pool, RowDataPacket } from "mysql2/promise";
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

export class InvalidTemplateError extends Error {}

export class EventRepository {
  constructor(private readonly pool: Pick<Pool, "getConnection"> = db) {}

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
