import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";

/** Parent-first locks match event deletion; mutations can share this access boundary. */
export async function withContractEvent<T>(
  connect: () => Promise<PoolConnection>, eventId: string, sub: string, exclusive: boolean,
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await connect();
  try {
    await connection.beginTransaction();
    const [events] = await connection.execute<RowDataPacket[]>(
      "SELECT event_id FROM events WHERE event_id = ? " + (exclusive ? "FOR UPDATE" : "FOR SHARE"), [eventId]);
    if (!events.length) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
    const [members] = await connection.execute<RowDataPacket[]>(`
      SELECT role FROM event_members WHERE event_id = ?
        AND cognito_sub COLLATE utf8mb4_bin = ? AND role IN ('OWNER','CO_PLANNER') FOR SHARE
    `, [eventId, sub]);
    if (!members.length) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
