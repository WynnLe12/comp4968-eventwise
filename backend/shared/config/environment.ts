import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// Source: backend/shared/config; compiled: backend/dist/shared/config.
const backendRoot = existsSync(resolve(__dirname, "../../package.json"))
  ? resolve(__dirname, "../..")
  : resolve(__dirname, "../../..");

// Shell/deployment variables win, then backend/.env, then repository-root .env.
for (const path of [resolve(backendRoot, ".env"), resolve(backendRoot, "../.env")]) {
  const result = config({ path, quiet: true });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new Error("Unable to read local .env configuration");
  }
}
