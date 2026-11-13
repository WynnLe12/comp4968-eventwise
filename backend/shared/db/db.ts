import mysql from "mysql2/promise";

export const db = mysql.createPool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? "3307"),
  user: process.env.DB_USER ?? "eventwise",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? "eventwise",
  waitForConnections: true,
  connectionLimit: 10,
});

export async function testDatabaseConnection(): Promise<void> {
  await db.query("SELECT 1");
}