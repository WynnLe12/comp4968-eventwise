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

export class InvalidTemplateError extends Error {}

export class EventRepository {
  constructor(private readonly pool: Pick<Pool, "getConnection"> = db) {}

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
