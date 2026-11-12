import type { Pool } from "mysql2/promise";
import { db } from "./db";

// Compatibility exports for the template repository; all services share one pool.
export function getPool(): Pool { return db; }
export async function closePool(): Promise<void> { await db.end(); }
