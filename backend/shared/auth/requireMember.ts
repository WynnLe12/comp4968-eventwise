// Event membership check shared by every /events/{eventId}/... route.
// Same rule and 403 as the expenses API: OWNER and CO_PLANNER may use the event,
// and a missing event gives the same 403, so the API never reveals which events exist.
import type { RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { getDatabasePool } from "../db/pool";

export async function requireMember(eventId: string | null, sub: string): Promise<string> {
  if (eventId !== null) {
    const [rows] = await getDatabasePool().execute<RowDataPacket[]>(
      "SELECT 1 FROM event_members WHERE event_id = ? AND cognito_sub = ? LIMIT 1",
      [eventId, sub],
    );
    if (rows.length > 0) return eventId;
  }
  throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
}
