import "../config/environment";
import { readFileSync } from "node:fs";
import { createPool, type Pool, type PoolOptions } from "mysql2/promise";
import { resolveDatabaseConfig, type DatabaseConfig } from "./config";

/** Deduplicate concurrent initialization; failed attempts may be retried. */
export function createLazyDatabasePool(
  loadConfig: () => Promise<DatabaseConfig> = resolveDatabaseConfig,
  makePool: (options: PoolOptions) => Pool = createPool,
) {
  let pending: Promise<Pool> | undefined;
  return {
    get(): Promise<Pool> {
      pending ??= loadConfig().then(config => makePool(databasePoolOptions(config))).catch(error => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    async close(): Promise<void> {
      const current = pending;
      pending = undefined;
      if (current) await (await current).end();
    },
  };
}
const lazyPool = createLazyDatabasePool();

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
      ? { ssl: { ca: readFileSync(config.sslCaFile, "utf8"), rejectUnauthorized: true, verifyIdentity: true } }
      : {}),
  };
}

// Lazy creation allows /health and unit tests to run without MySQL.
// Reuse one pool per process (or warm Lambda execution environment).
export function getDatabasePool(): Pool { return sharedPool; }

export async function closeDatabasePool(): Promise<void> {
  await lazyPool.close();
}

// Compatibility names used by event, template and budget repositories.
export const sharedPool = new Proxy({} as Pool, {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    if (property === "end") return closeDatabasePool;
    // Keep existing synchronous pool getters while awaiting credentials before SQL operations.
    if (property === "then") return undefined;
    return async (...args: unknown[]) => {
      const current = await lazyPool.get();
      const method = Reflect.get(current, property, current);
      return Reflect.apply(method, current, args);
    };
  },
});
export function getPool(): Pool { return sharedPool; }
export const closePool = closeDatabasePool;