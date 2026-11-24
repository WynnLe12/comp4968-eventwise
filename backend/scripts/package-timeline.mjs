import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Builds backend/build/eventwise-timeline.zip for the eventwise-timeline Lambda (Feature 13).
// Invoke via npm run package:timeline, which compiles TypeScript first.
// Handler: timeline-service/lambda/timeline.handler (Node.js 22.x, x86_64).
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const build = join(root, 'build');
mkdirSync(build, { recursive: true });
const staging = mkdtempSync(join(build, 'timeline-package-'));
const archive = `${staging}.zip`;
const output = join(build, 'eventwise-timeline.zip');

try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) throw new Error('Run this script with npm run package:timeline');
  for (const name of ['package.json', 'package-lock.json']) {
    cpSync(join(root, name), join(staging, name));
  }
  // Timeline needs its own service, the shared DB/auth/config modules and the RDS CA certificate.
  // Copy only compiled runtime code, never server.js, tests or .env.
  for (const name of ['timeline-service', 'shared', 'certs']) {
    cpSync(join(root, 'dist', name), join(staging, name), { recursive: true });
  }
  // Cognito's public signing keys, for verifying ID tokens offline (no internet in the VPC).
  cpSync(join(root, 'certs', 'cognito-jwks.json'), join(staging, 'certs', 'cognito-jwks.json'));
  // ApiError lives in the expense service; nothing else from it is needed.
  mkdirSync(join(staging, 'expense-service'));
  cpSync(join(root, 'dist', 'expense-service', 'errors.js'), join(staging, 'expense-service', 'errors.js'));

  // Production dependencies for Lambda's Linux x86_64 runtime, even when packaging on a Mac
  // (same flags as package-photos.mjs; keeps native packages such as sharp Linux-compatible).
  execFileSync(process.execPath, [
    npmCli, 'ci', '--omit=dev', '--os=linux', '--cpu=x64', '--libc=glibc',
    '--ignore-scripts', '--no-audit', '--no-fund',
  ], { cwd: staging, stdio: 'inherit' });
  // The photo gallery's image library is most of the package and timeline never loads it.
  // The smoke checks below fail if anything still requires it.
  for (const name of ['sharp', '@img']) {
    rmSync(join(staging, 'node_modules', name), { recursive: true, force: true });
  }

  // Smoke checks run against the staged package only, with no AWS credentials or settings.
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
    const env = ['TIMELINE_SHARE_SECRET', 'GUEST_APP_ORIGIN', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID'];
    for (const name of env) delete process.env[name];
    assert.equal(fs.existsSync('node_modules/sharp'), false, 'sharp should not be packaged');
    const { handler } = require('./timeline-service/lambda/timeline.js');
    assert.equal(typeof handler, 'function');
    new X509Certificate(fs.readFileSync('./certs/rds-ca.pem'));
    const { DEFAULT_JWKS_FILE } = require('./timeline-service/services/idTokenEmail.js');
    assert.equal(path.relative(process.cwd(), DEFAULT_JWKS_FILE), path.join('certs', 'cognito-jwks.json'));
    assert.ok(JSON.parse(fs.readFileSync(DEFAULT_JWKS_FILE, 'utf8')).keys.length > 0, 'Cognito JWKS has no keys');
    (async () => {
      const preflight = await handler({ httpMethod: 'OPTIONS', resource: '/events/{eventId}/timeline' });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.body, '');
      const denied = await handler({ httpMethod: 'GET', resource: '/events/{eventId}/timeline', pathParameters: { eventId: '42' } });
      assert.equal(denied.statusCode, 401);
      assert.equal(JSON.parse(denied.body).error.code, 'UNAUTHENTICATED');
      const wrongMethod = await handler({ httpMethod: 'PUT', resource: '/events/{eventId}/timeline' });
      assert.equal(wrongMethod.statusCode, 405);
      const unknown = await handler({ httpMethod: 'GET', resource: '/events/{eventId}/vendors' });
      assert.equal(unknown.statusCode, 404);
      // Without TIMELINE_SHARE_SECRET the public route fails closed before any AWS call.
      const original = console.error;
      console.error = () => {};
      const guest = await handler({ httpMethod: 'GET', resource: '/guest-timeline/{share}', pathParameters: { share: '42-x' } });
      console.error = original;
      assert.equal(guest.statusCode, 500);
      console.log('Timeline package smoke checks passed');
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
  console.log('Lambda handler: timeline-service/lambda/timeline.handler');
} finally {
  const target = realpathSync(staging);
  const inside = relative(realpathSync(build), target);
  if (!inside || inside.startsWith('..') || resolve(target) === resolve(build)) {
    throw new Error('Unsafe staging path');
  }
  rmSync(target, { recursive: true, force: true });
  rmSync(archive, { force: true });
}
