import "./shared/config/environment";
import { closeDatabasePool } from "./shared/db/pool";
import { createServer, type Server } from "node:http";
import { sendJson, type ErrorResponse, type HealthResponse } from "./shared/utils/http";

import { ExpenseService } from "./expense-service/services/expenses";
import { MySqlExpenseRepository } from "./expense-service/repositories/mysql-expenses";
import { expenseHttpHandler } from "./expense-service/handlers/http";
import { createCognitoAuthenticator, type Authenticate } from "./shared/auth/cognito";

export interface AppDependencies {
  expenses?: ExpenseService;
  authenticate?: Authenticate;
}
// Tests inject dependencies in code; no request header or environment auth bypass.
export function createAppServer(dependencies: AppDependencies = {}): Server {
  const expenses = expenseHttpHandler(
    dependencies.expenses ?? new ExpenseService(new MySqlExpenseRepository()),
    dependencies.authenticate ?? createCognitoAuthenticator());
  return createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      sendJson<HealthResponse>(response, 200, { status: "ok" });
      return;
    }
    void expenses(request, response).then(handled => {
      if (!handled) sendJson<ErrorResponse>(response, 404, { error: "Not found" });
    }).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Unable to complete the request." } });
      }
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? "3000");
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const server = createAppServer();
  server.on("error", (error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`EventWise backend listening on http://${host}:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => {
      void closeDatabasePool().catch(() => {
        console.error("Unable to close database connections cleanly");
        process.exitCode = 1;
      });
    }));
  }
}
