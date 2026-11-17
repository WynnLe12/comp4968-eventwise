import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Invoke via npm run package:expenses, which compiles TypeScript first.
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const build = join(root, 'build');
mkdirSync(build, { recursive: true });
const staging = mkdtempSync(join(build, 'expenses-package-'));
const archive = `${staging}.zip`;
const output = join(build, 'eventwise-expenses.zip');

try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) throw new Error('Run this script with npm run package:expenses');
  for (const name of ['package.json', 'package-lock.json']) {
    cpSync(join(root, name), join(staging, name));
  }
  // Expenses depends on shared DB/config/utilities; other feature services are not needed.
  // Copy only compiled runtime code and the RDS certificate, never server.js or .env.
  for (const name of ['expense-service', 'shared', 'certs']) {
    cpSync(join(root, 'dist', name), join(staging, name), { recursive: true });
  }
  // Keep the team's lockfile and all production dependencies; no runtime-bundled SDK assumption.
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging, stdio: 'inherit',
  });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const { X509Certificate } = require('node:crypto');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) {
      const resolved = originalResolve.apply(this, args);
      if (path.isAbsolute(resolved) && !resolved.startsWith(process.cwd() + path.sep)) {
        throw new Error('Dependency resolved outside the deployment package');
      }
      return resolved;
    };
    for (const name of ['.env', 'server.js', 'tests', 'verification', 'node_modules/typescript', 'node_modules/tsx']) {
      assert.equal(fs.existsSync(name), false, 'Unexpected package entry: ' + name);
    }
    const { handler } = require('./expense-service/lambda/expenses.js');
    assert.equal(typeof handler, 'function');
    new X509Certificate(fs.readFileSync('./certs/rds-ca.pem'));
    (async () => {
      const denied = await handler({ httpMethod: 'GET', path: '/events/400/expenses' });
      assert.equal(denied.statusCode, 401);
      assert.equal(JSON.parse(denied.body).error.code, 'UNAUTHENTICATED');
      const preflight = await handler({ httpMethod: 'OPTIONS', path: '/events/400/expenses' });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.body, '');
      console.log('Expenses package smoke checks passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: staging, stdio: 'inherit' });

  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-a', '-cf', archive, '-C', staging, '.'], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', archive, '.'], { cwd: staging, stdio: 'inherit' });
  }
  // Replace the prior artifact only after installation, smoke checks and archiving succeed.
  renameSync(archive, output);
  console.log(`Created ${output}`);
  console.log('Lambda handler: expense-service/lambda/expenses.handler');
} finally {
  const target = realpathSync(staging);
  const inside = relative(realpathSync(build), target);
  if (!inside || inside.startsWith('..') || resolve(target) === resolve(build)) {
    throw new Error('Unsafe staging path');
  }
  rmSync(target, { recursive: true, force: true });
  rmSync(archive, { force: true });
}
