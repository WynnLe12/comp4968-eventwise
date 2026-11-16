import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = mkdtempSync(join(tmpdir(), 'eventwise-templates-'));
const output = '/tmp/eventwise-event-templates.zip';
try {
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, name), join(staging, name));
  for (const name of ['event-service', 'shared', 'certs']) cpSync(join(root, 'dist', name), join(staging, name), { recursive: true });
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--cache', '/tmp/eventwise-npm-cache'], { cwd: staging, stdio: 'inherit' });
  rmSync(output, { force: true });
  execFileSync('zip', ['-qr', output, '.'], { cwd: staging, stdio: 'inherit' });
  console.log(`Created ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
