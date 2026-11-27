import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const build = join(root, 'build');
mkdirSync(build, { recursive: true });
const staging = mkdtempSync(join(build, 'alerts-package-'));
const output = join(build, 'eventwise-alerts.zip');

function removeStaging() {
  const target = realpathSync(staging);
  const inside = relative(realpathSync(build), target);
  if (!inside || inside.startsWith('..') || resolve(target) === resolve(build)) {
    throw new Error('Unsafe staging path');
  }
  rmSync(target, { recursive: true, force: true });
}

try {
  for (const name of ['package.json', 'package-lock.json']) {
    cpSync(join(root, name), join(staging, name));
  }
  // Alert service imports expense-service/services/validation (cents/money) and shared/db/pool.
  for (const name of ['notification-service', 'expense-service', 'shared', 'certs']) {
    cpSync(join(root, 'dist', name), join(staging, name), { recursive: true });
  }
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error('Run this script with npm run package:alerts');
  }
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging,
    stdio: 'inherit',
  });

  // Smoke-load with no parent node_modules resolution and verify bundled RDS CA certificate.
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) {
      const resolved = originalResolve.apply(this, args);
      if (path.isAbsolute(resolved) && !resolved.startsWith(process.cwd() + path.sep)) {
        throw new Error('Dependency resolved outside the deployment package');
      }
      return resolved;
    };
    const { X509Certificate } = require('node:crypto');
    const { handler: alertsHandler } = require('./notification-service/handlers/alerts.js');
    const { handler: emailSenderHandler } = require('./notification-service/handlers/emailSender.js');
    if (typeof alertsHandler !== 'function') throw new Error('Missing Alerts handler');
    if (typeof emailSenderHandler !== 'function') throw new Error('Missing Alert Email Sender handler');
    new X509Certificate(fs.readFileSync('./certs/rds-ca.pem'));
    if (fs.existsSync('.env')) throw new Error('Unexpected environment file');
  `], { cwd: staging, stdio: 'inherit' });

  if (existsSync(output)) rmSync(output);
  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-a', '-cf', output, '-C', staging, '.'], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', output, '.'], { cwd: staging, stdio: 'inherit' });
  }
  console.log(`Created ${dirname(output)}${sep}${'eventwise-alerts.zip'}`);
} finally {
  removeStaging();
}
