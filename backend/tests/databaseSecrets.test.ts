import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "mysql2/promise";
import { resolveDatabaseConfig } from "../shared/db/config";
import { createLazyDatabasePool, databasePoolOptions } from "../shared/db/pool";

const aws = { DB_SECRET_ARN: "arn:test:secret", DB_HOST: "db.example", DB_NAME: "eventwise" };
const secret = async () => JSON.stringify({ username: "aws-user", password: " aws-password " });

test("local credentials do not call Secrets Manager and retain local defaults", async () => {
  const config = await resolveDatabaseConfig({ DB_USER: "local", DB_PASSWORD: "password", DB_NAME: "db" }, async () => { throw new Error("must not call AWS"); });
  assert.equal(config.user, "local");
  assert.equal(config.port, 3307);
  assert.equal(config.sslCaFile, undefined);
});

test("secret mode takes precedence and uses RDS port and verified TLS", async () => {
  const config = await resolveDatabaseConfig({ ...aws, DB_USER: "ignored", DB_PASSWORD: "ignored" }, async arn => {
    assert.equal(arn, aws.DB_SECRET_ARN);
    return secret();
  });
  assert.equal(config.user, "aws-user");
  assert.equal(config.password, " aws-password ");
  assert.equal(config.port, 3306);
  const ssl = databasePoolOptions(config).ssl;
  assert.ok(ssl && typeof ssl === "object");
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.verifyIdentity, true);
  assert.match(String(ssl.ca), /BEGIN CERTIFICATE/);
});

test("explicit RDS port and CA path are respected", async () => {
  const config = await resolveDatabaseConfig({ ...aws, DB_PORT: "3306", DB_SSL_CA_FILE: "/custom/ca.pem" }, secret);
  assert.equal(config.port, 3306);
  assert.equal(config.sslCaFile, "/custom/ca.pem");
});

test("invalid secrets and retrieval errors never expose secret content or fall back", async () => {
  for (const value of [undefined, "sensitive-invalid-json", "null", "[]", "{}", '{"username":"a","password":1}', '{"username":"","password":"sensitive"}']) {
    await assert.rejects(resolveDatabaseConfig({ ...aws, DB_USER: "fallback", DB_PASSWORD: "fallback" }, async () => value), /^(Error: )?(Unable to retrieve or parse database secret|Database secret must contain nonempty username and password strings)$/);
  }
  await assert.rejects(resolveDatabaseConfig(aws, async () => { throw new Error("sensitive SDK details"); }), { message: "Unable to retrieve or parse database secret" });
  await assert.rejects(resolveDatabaseConfig({ ...aws, DB_HOST: "" }, secret), /DB_HOST is required/);
});

test("concurrent pool initialization fetches credentials once and reuses the pool", async () => {
  let fetches = 0;
  let creations = 0;
  let closes = 0;
  const pool = { async end() { closes++; } } as unknown as Pool;
  const lazy = createLazyDatabasePool(async () => {
    fetches++;
    return resolveDatabaseConfig(aws, secret);
  }, () => { creations++; return pool; });
  assert.deepEqual(await Promise.all([lazy.get(), lazy.get(), lazy.get()]), [pool, pool, pool]);
  assert.equal(await lazy.get(), pool);
  assert.equal(fetches, 1);
  assert.equal(creations, 1);
  await lazy.close();
  assert.equal(closes, 1);
  await lazy.get();
  assert.equal(fetches, 2);
});

test("failed initialization is retryable without caching a rejected secret request", async () => {
  let attempts = 0;
  const pool = {} as Pool;
  const lazy = createLazyDatabasePool(async () => {
    if (++attempts === 1) throw new Error("temporary failure");
    return resolveDatabaseConfig(aws, secret);
  }, () => pool);
  await assert.rejects(lazy.get(), /temporary failure/);
  assert.equal(await lazy.get(), pool);
  assert.equal(attempts, 2);
});

test("missing TLS certificate fails instead of disabling verification", async () => {
  const config = await resolveDatabaseConfig({ ...aws, DB_SSL_CA_FILE: "/nonexistent/rds-ca.pem" }, secret);
  assert.throws(() => databasePoolOptions(config), /ENOENT/);
});
