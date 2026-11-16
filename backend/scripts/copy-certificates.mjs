import { cpSync, mkdirSync } from 'node:fs';
const root = new URL('../', import.meta.url);
mkdirSync(new URL('dist/certs/', root), { recursive: true });
cpSync(new URL('certs/rds-ca.pem', root), new URL('dist/certs/rds-ca.pem', root));
