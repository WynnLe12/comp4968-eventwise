// Reads the event header shown on the public guest timeline (name, date, venue) from RDS.
// Only these three columns are read; budgets, members and other event data never leave MySQL.

import type { RowDataPacket } from "mysql2/promise";
import { getDatabasePool } from "../../shared/db/pool";

export interface EventSummary {
  name: string;
  /** "YYYY-MM-DD" (the pool uses dateStrings), or null when the event has no date yet. */
  eventDate: string | null;
  venue: string | null;
}

export type EventSummaryLookup = (eventId: string) => Promise<EventSummary | null>;

type Execute = (sql: string, values: unknown[]) => Promise<[RowDataPacket[], unknown]>;

export function createEventSummaryLookup(
  execute: Execute = (sql, values) => getDatabasePool().execute<RowDataPacket[]>(sql, values as never),
): EventSummaryLookup {
  return async (eventId) => {
    const [rows] = await execute("SELECT name, event_date, venue FROM events WHERE event_id = ? LIMIT 1", [eventId]);
    const row = rows[0];
    if (!row) return null;
    return {
      name: String(row.name),
      eventDate: row.event_date === null || row.event_date === undefined ? null : String(row.event_date).slice(0, 10),
      venue: row.venue === null || row.venue === undefined ? null : String(row.venue),
    };
  };
}
