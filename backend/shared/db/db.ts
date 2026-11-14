import { sharedPool } from "./pool";

// Existing event repositories and compatibility getters share this lazy facade.
export const db = sharedPool;

export async function testDatabaseConnection(): Promise<void> {
  await db.query("SELECT 1");
}
