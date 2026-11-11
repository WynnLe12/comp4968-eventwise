import { createPool, type Pool } from "mysql2/promise";

let pool: Pool | undefined;

/** Lazy shared pool. Export DB_* variables in the process environment. */
export function getPool(): Pool {
  if (!pool) {
    const port = Number(process.env.DB_PORT ?? "3307");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("DB_PORT must be an integer between 1 and 65535");
    }
    pool = createPool({
      host: process.env.DB_HOST ?? "127.0.0.1",
      port,
      user: process.env.DB_USER ?? "eventwise",
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME ?? "eventwise",
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 50,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      // Keep DECIMAL values as strings to preserve precision.
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}
