import { closeDatabasePool, getDatabasePool } from "./pool";

async function main(): Promise<void> {
  try {
    await getDatabasePool().query("SELECT 1 AS connection_check");
    console.log("MySQL connection successful.");
  } catch {
    // Driver errors can contain server/user details; do not print credentials.
    console.error("MySQL connection failed. Check .env, database availability, port and TLS configuration.");
    process.exitCode = 1;
  } finally {
    await closeDatabasePool();
  }
}

if (require.main === module) void main();
