import "../config/environment";
import { readFileSync } from "node:fs";
import { createPool, type Pool, type PoolOptions } from "mysql2/promise";
import { readDatabaseConfig, type DatabaseConfig } from "./config";

let pool: Pool | undefined;

export function databasePoolOptions(config: DatabaseConfig): PoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    connectTimeout: config.connectTimeout,
    waitForConnections: true,
    queueLimit: 50,
    charset: "utf8mb4",
    timezone: "Z",
    // Preserve financial values and BIGINT identifiers as strings.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    ...(config.sslCaFile
      ? { ssl: { ca: readFileSync(config.sslCaFile, "utf8"), rejectUnauthorized: true } }
      : {}),
  };
}

// Lazy creation allows /health and unit tests to run without MySQL.
// Reuse one pool per process (or warm Lambda execution environment).
export function getDatabasePool(): Pool {
  pool ??= createPool(databasePoolOptions(readDatabaseConfig()));
  return pool;
}

export async function closeDatabasePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}

// Compatibility names used by event, template and budget repositories.
export const sharedPool = new Proxy({} as Pool, {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    if (property === "end") return closeDatabasePool;
    const current = getDatabasePool();
    const value = Reflect.get(current, property, current);
    return typeof value === "function" ? value.bind(current) : value;
  },
});
export function getPool(): Pool { return sharedPool; }
export const closePool = closeDatabasePool;