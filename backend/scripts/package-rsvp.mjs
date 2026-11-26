import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Builds backend/build/eventwise-rsvp.zip for Feature 8 (invitations and RSVP).
// Invoke via npm run package:rsvp, which compiles TypeScript first.
// Handlers (Node.js 22.x, x86_64), all from this one ZIP, all OUTSIDE the VPC:
//   eventwise-rsvp               rsvp-service/lambda/rsvp.handler         (API Gateway)
//   eventwise-rsvp-deadline      rsvp-service/lambda/deadline.handler     (Step Functions)
//   eventwise-rsvp-email-sender  rsvp-service/lambda/emailSender.handler  (SQS trigger)
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const build = join(root, 'build');
mkdirSync(build, { recursive: true });
const staging = mkdtempSync(join(build, 'rsvp-package-'));
const archive = `${staging}.zip`;
const output = join(build, 'eventwise-rsvp.zip');

try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) throw new Error('Run this script with npm run package:rsvp');
  for (const name of ['package.json', 'package-lock.json']) {
    cpSync(join(root, name), join(staging, name));
  }
  // RSVP needs its own service and the shared DynamoDB client and share-secret rules.
  // Copy only compiled runtime code, never server.js, tests or .env.
  cpSync(join(root, 'dist', 'rsvp-service'), join(staging, 'rsvp-service'), { recursive: true });
  mkdirSync(join(staging, 'shared', 'db'), { recursive: true });
  mkdirSync(join(staging, 'shared', 'auth'), { recursive: true });
  cpSync(join(root, 'dist', 'shared', 'db', 'dynamodb.js'), join(staging, 'shared', 'db', 'dynamodb.js'));
  cpSync(join(root, 'dist', 'shared', 'auth', 'eventShare.js'), join(staging, 'shared', 'auth', 'eventShare.js'));
  // ApiError lives in the expense service; nothing else from it is needed.
  mkdirSync(join(staging, 'expense-service'));
  cpSync(join(root, 'dist', 'expense-service', 'errors.js'), join(staging, 'expense-service', 'errors.js'));

  // Production dependencies for Lambda's Linux x86_64 runtime, even when packaging on a Mac.
  execFileSync(process.execPath, [
    npmCli, 'ci', '--omit=dev', '--os=linux', '--cpu=x64', '--libc=glibc',
    '--ignore-scripts', '--no-audit', '--no-fund',
  ], { cwd: staging, stdio: 'inherit' });
  // The photo gallery's image library is most of the package and RSVP never loads it.
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
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) {
      const resolved = originalResolve.apply(this, args);
      if (path.isAbsolute(resolved) && !resolved.startsWith(process.cwd() + path.sep)) {
        throw new Error('Dependency resolved outside the deployment package');
      }
      return resolved;
    };
    for (const name of ['.env', 'server.js', 'tests', 'verification', 'node_modules/typescript', 'node_modules/tsx', 'node_modules/sharp']) {
      assert.equal(fs.existsSync(name), false, 'Unexpected package entry: ' + name);
    }
    for (const name of ['RSVP_LINK_SECRET', 'GUEST_APP_ORIGIN', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'EVENT_API_URL']) {
      delete process.env[name];
    }
    const { handler } = require('./rsvp-service/lambda/rsvp.js');
    assert.equal(typeof handler, 'function');
    assert.equal(typeof require('./rsvp-service/lambda/deadline.js').handler, 'function');
    const { createEmailSenderHandler } = require('./rsvp-service/lambda/emailSender.js');
    (async () => {
      const preflight = await handler({ httpMethod: 'OPTIONS', resource: '/rsvp/{token}' });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.body, '');
      const denied = await handler({ httpMethod: 'GET', resource: '/events/{eventId}/rsvp', pathParameters: { eventId: '42' } });
      assert.equal(denied.statusCode, 401);
      assert.equal(JSON.parse(denied.body).error.code, 'UNAUTHENTICATED');
      const wrongMethod = await handler({ httpMethod: 'DELETE', resource: '/rsvp/{token}' });
      assert.equal(wrongMethod.statusCode, 405);
      const unknown = await handler({ httpMethod: 'GET', resource: '/events/{eventId}/vendors' });
      assert.equal(unknown.statusCode, 404);
      // Without RSVP_LINK_SECRET the public route fails closed before any AWS call.
      const original = console.error;
      console.error = () => {};
      const guest = await handler({ httpMethod: 'GET', resource: '/rsvp/{token}', pathParameters: { token: '42.abc.x' } });
      console.error = original;
      assert.equal(guest.statusCode, 500);
      // The sender retries everything when SES_FROM_ADDRESS is missing, without calling SES.
      const senderCheck = await createEmailSenderHandler(async () => { throw new Error('SES must not be called'); }, {}, () => {})(
        { Records: [{ messageId: 'm1', body: '{}' }] });
      assert.deepEqual(senderCheck, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
      console.log('RSVP package smoke checks passed');
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
  console.log('Lambda handlers: rsvp-service/lambda/rsvp.handler (API), rsvp-service/lambda/deadline.handler (Step Functions), rsvp-service/lambda/emailSender.handler (SQS)');
} finally {
  const target = realpathSync(staging);
  const inside = relative(realpathSync(build), target);
  if (!inside || inside.startsWith('..') || resolve(target) === resolve(build)) {
    throw new Error('Unsafe staging path');
  }
  rmSync(target, { recursive: true, force: true });
  rmSync(archive, { force: true });
}
