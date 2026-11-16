import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { resolve } from "node:path";

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

export type ReadSecret = (arn: string) => Promise<string | undefined>;
const secrets = new SecretsManagerClient({});
const readSecret: ReadSecret = async arn => {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : undefined);
};

/** Secret credentials take precedence; never fall back to local credentials on failure. */
export async function resolveDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  fetchSecret: ReadSecret = readSecret,
): Promise<DatabaseConfig> {
  const arn = env.DB_SECRET_ARN?.trim();
  if (!arn) return readDatabaseConfig(env);
  required(env, "DB_HOST");
  required(env, "DB_NAME");
  let credentials: unknown;
  try {
    const value = await fetchSecret(arn);
    credentials = JSON.parse(value ?? "");
  } catch {
    // SDK/parser errors may contain sensitive response content. Do not propagate them.
    throw new Error("Unable to retrieve or parse database secret");
  }
  if (!credentials || typeof credentials !== "object" ||
      !("username" in credentials) || typeof credentials.username !== "string" || !credentials.username.trim() ||
      !("password" in credentials) || typeof credentials.password !== "string" || !credentials.password.trim()) {
    throw new Error("Database secret must contain nonempty username and password strings");
  }
  return readDatabaseConfig({
    ...env,
    DB_USER: credentials.username,
    DB_PASSWORD: credentials.password,
    DB_PORT: env.DB_PORT ?? "3306",
    // A packaged RDS trust bundle is mandatory in secret mode; verification cannot be disabled.
    DB_SSL_CA_FILE: env.DB_SSL_CA_FILE?.trim() || resolve(__dirname, "../../certs/rds-ca.pem"),
  });
}
