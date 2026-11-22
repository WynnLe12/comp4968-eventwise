import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const build = join(root, 'build');
mkdirSync(build, { recursive: true });
const staging = mkdtempSync(join(build, 'events-package-'));
const output = join(build, 'eventwise-events.zip');
// Every recursively removed directory must remain in this task's build directory.
function removeStaging() {
  const target = realpathSync(staging);
  const inside = relative(realpathSync(build), target);
  if (!inside || inside.startsWith('..') || resolve(target) === resolve(build)) throw new Error('Unsafe staging path');
  rmSync(target, { recursive: true, force: true });
}
try {
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, name), join(staging, name));
  // Shared auth imports expense-service/errors; event deletion imports guest-service.
  // Copy the entire compiled runtime module set so transitive imports remain available.
  for (const name of ['event-service', 'guest-service', 'expense-service', 'vendor-service', 'shared', 'certs']) {
    cpSync(join(root, 'dist', name), join(staging, name), { recursive: true });
  }
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) throw new Error('Run this script with npm run package:events');
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging, stdio: 'inherit',
  });
  // Smoke-load with no parent node_modules resolution and no application requests.
  // Dependencies are installed inside staging, and no server listener is packaged.
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
    const { handler } = require('./event-service/lambda/events.js');
    if (typeof handler !== 'function') throw new Error('Missing Events handler');
    new X509Certificate(fs.readFileSync('./certs/rds-ca.pem'));
    if (fs.existsSync('.env')) throw new Error('Unexpected environment file');
  `], { cwd: staging, stdio: 'inherit' });
  if (existsSync(output)) rmSync(output);
  
  
if (process.platform === 'win32') {
  // Create ZIP entries with forward slashes for AWS Lambda.
  const pythonScript = `
import os
import sys
import zipfile

staging, output = sys.argv[1], sys.argv[2]

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for current_dir, dirs, files in os.walk(staging):
        for filename in files:
            full_path = os.path.join(current_dir, filename)
            relative_path = os.path.relpath(full_path, staging)
            archive.write(full_path, relative_path.replace(os.sep, "/"))
`;

  execFileSync(
    'python',
    ['-c', pythonScript, staging, output],
    { stdio: 'inherit' }
  );
} else {
  execFileSync('zip', ['-qr', output, '.'], {
    cwd: staging,
    stdio: 'inherit',
  });
}

  // Keep artifact path portable and explicit; no AWS commands are executed.
  console.log(`Created ${dirname(output)}${sep}${'eventwise-events.zip'}`);
} finally {
  removeStaging();
}
