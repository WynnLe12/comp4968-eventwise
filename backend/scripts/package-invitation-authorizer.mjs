import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const build = join(root, 'build');
mkdirSync(build, { recursive: true });
const buildPath = realpathSync(build);
const staging = mkdtempSync(join(buildPath, 'invitation-authorizer-package-'));
const output = join(buildPath, 'eventwise-invitation-authorizer.zip');
const handler = 'event-service/lambda/invitationAuthorizer.js';

try {
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, name), join(staging, name));
  for (const file of [handler, 'event-service/invitationAcceptanceAuth.js', 'event-service/invitationEmail.js',
    'shared/auth/verifiedEmail.js', 'shared/auth/profileDisplayName.js']) {
    const target = join(staging, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, 'dist', file), target);
  }
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this script with npm run package:invitation-authorizer');
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging, stdio: 'inherit',
  });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
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
    const methodArn = 'arn:aws:execute-api:us-west-2:123456789012:hd63bpgxm8/prod/POST/event-invitations/accept';
    process.env.EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN = methodArn;
    process.env.EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE = 'true';
    process.env.COGNITO_USER_POOL_ID = 'us-west-2_testpool';
    process.env.COGNITO_CLIENT_ID = 'testclient';
    const { handler } = require('./${handler}');
    assert.rejects(handler({ type: 'TOKEN', methodArn, authorizationToken: 'Bearer malformed' }), { message: 'Unauthorized' })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: staging, stdio: 'inherit' });
  rmSync(output, { force: true });
  if (process.platform === 'win32') {
    execFileSync('python', ['-m', 'zipfile', '-c', output, 'package.json', 'package-lock.json', 'event-service', 'shared', 'node_modules'], {
      cwd: staging, stdio: 'inherit',
    });
  } else {
    execFileSync('zip', ['-qr', output, '.'], { cwd: staging, stdio: 'inherit' });
  }
  console.log(`Created ${output}`);
} finally {
  const target = realpathSync(staging);
  if (dirname(target) !== buildPath || target !== staging) throw new Error('Unsafe staging path');
  rmSync(target, { recursive: true, force: true });
}
