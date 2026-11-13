export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  connectTimeout: number;
  sslCaFile?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return value;
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return {
    host: env.DB_HOST?.trim() || "127.0.0.1",
    port: integer(env, "DB_PORT", 3307, 65535),
    user: required(env, "DB_USER"),
    password: required(env, "DB_PASSWORD"),
    database: required(env, "DB_NAME"),
    connectionLimit: integer(env, "DB_CONNECTION_LIMIT", 5, 100),
    connectTimeout: integer(env, "DB_CONNECT_TIMEOUT_MS", 10000, 120000),
    ...(env.DB_SSL_CA_FILE?.trim() ? { sslCaFile: env.DB_SSL_CA_FILE.trim() } : {}),
  };
}
