// Read-only checks against the SAME disposable Docker database as db-seed.mjs.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const sql = readFileSync(new URL('../database/mysql/verification/expenses_seed_checks.sql', import.meta.url), 'utf8');
const result = spawnSync('docker', [
  'exec', '-i', '-e', 'MYSQL_PWD=localpass', 'eventwise-mysql',
  'mysql', '-ueventwise', '--batch', '--skip-column-names', 'eventwise',
], { input: sql, encoding: 'utf8' });
if (result.error || result.status !== 0) {
  console.error('Fixture verification could not run. Start Docker/MySQL and load 03_expenses_seed.sql.');
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}
const rows = result.stdout.trim().split('\n').filter(Boolean);
for (const row of rows) console.log(row);
if (rows.length !== 17 || rows.some(row => row.split('\t')[1] !== 'PASS')) {
  console.error('Expense fixture verification failed. Expected 17 PASS results.');
  process.exit(1);
}
console.log('All 17 expense fixture checks passed.');
