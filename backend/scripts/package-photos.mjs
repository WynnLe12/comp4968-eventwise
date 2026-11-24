import { cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist", "photo-gallery");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) {
  cpSync(join(root, file), join(output, file));
}
for (const directory of ["photo-service", "shared", "certs"]) {
  cpSync(join(root, "dist", directory), join(output, directory), { recursive: true });
}
mkdirSync(join(output, "expense-service"));
cpSync(join(root, "dist", "expense-service", "errors.js"), join(output, "expense-service", "errors.js"));

const install = spawnSync("npm", [
  "ci", "--omit=dev", "--os=linux", "--cpu=x64", "--libc=glibc", "--no-audit", "--no-fund",
], { cwd: output, stdio: "inherit" });
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);
