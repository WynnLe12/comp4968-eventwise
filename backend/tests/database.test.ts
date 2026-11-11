import assert from "node:assert/strict";
import { test } from "node:test";
import { readDatabaseConfig } from "../shared/db/config";
import { databasePoolOptions } from "../shared/db/pool";

const credentials = { DB_USER: "test-user", DB_PASSWORD: "test-password", DB_NAME: "test-db" };

test("database configuration rejects absent credentials without exposing values", () => {
  for (const field of ["DB_USER", "DB_PASSWORD", "DB_NAME"] as const) {
    assert.throws(() => readDatabaseConfig({ ...credentials, [field]: "" }), new RegExp(`${field} is required`));
  }
});

test("database configuration validates numeric ranges and malformed values", () => {
  for (const value of ["0", "-1", "3307.5", "3307x", "65536", ""]) {
    assert.throws(() => readDatabaseConfig({ ...credentials, DB_PORT: value }));
  }
  assert.throws(() => readDatabaseConfig({ ...credentials, DB_CONNECTION_LIMIT: "101" }));
  assert.throws(() => readDatabaseConfig({ ...credentials, DB_CONNECT_TIMEOUT_MS: "0" }));
  const config = readDatabaseConfig({ ...credentials, DB_PORT: "3306", DB_CONNECTION_LIMIT: "2" });
  assert.equal(config.port, 3306);
  assert.equal(config.connectionLimit, 2);
});

test("pool options preserve decimals and large identifiers and disable multi-statements", () => {
  const options = databasePoolOptions(readDatabaseConfig(credentials));
  assert.equal(options.decimalNumbers, false);
  assert.equal(options.supportBigNumbers, true);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.dateStrings, true);
  assert.equal(options.multipleStatements, false);
  assert.equal(options.timezone, "Z");
});
