// Loads seed data into the local Docker MySQL (container "eventwise-mysql").
//
//   node scripts/db-seed.mjs                       every .sql file in database/mysql/seeds, in name order
//   node scripts/db-seed.mjs 02_vendors_seed.sql   only the files named
//
// Usually run through npm from backend/: `npm run db:seed` or `npm run db:seed -- 02_vendors_seed.sql`.
// Uses Node instead of a shell loop so it works the same on macOS, Linux and Windows.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEEDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "database", "mysql", "seeds");
const CONTAINER = "eventwise-mysql";

const requested = process.argv.slice(2);
const available = readdirSync(SEEDS_DIR).filter((f) => f.endsWith(".sql")).sort();

const missing = requested.filter((f) => !available.includes(f));
if (missing.length > 0) {
  console.error(`No such seed file: ${missing.join(", ")}`);
  console.error(`Available: ${available.join(", ")}`);
  process.exit(1);
}

const files = requested.length > 0 ? available.filter((f) => requested.includes(f)) : available;
if (files.length === 0) {
  console.error(`No .sql files in ${SEEDS_DIR}`);
  process.exit(1);
}

for (const file of files) {
  process.stdout.write(`Seeding ${file} ... `);
  // MYSQL_PWD instead of -p avoids the "password on the command line" warning.
  const result = spawnSync(
    "docker",
    ["exec", "-i", "-e", "MYSQL_PWD=localpass", CONTAINER, "mysql", "-ueventwise", "eventwise"],
    { input: readFileSync(join(SEEDS_DIR, file)), stdio: ["pipe", "inherit", "pipe"] },
  );

  if (result.error) {
    console.log("failed");
    console.error(`Couldn't run docker: ${result.error.message}. Is Docker Desktop installed and running?`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.log("failed");
    const stderr = result.stderr.toString();
    process.stderr.write(stderr);
    if (/No such container|is not running/i.test(stderr)) {
      console.error("Start the database first: npm run db:up");
    }
    process.exit(result.status ?? 1);
  }
  console.log("done");
}
