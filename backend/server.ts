import { createServer, type Server } from "node:http";
import { handleTemplates } from "./event-service/handlers/templates";
import { handleBudgetCategories } from "./event-service/handlers/budgetCategories";
import { closePool } from "./shared/db/pool";
import { sendJson, type ErrorResponse, type HealthResponse } from "./shared/utils/http";

// Local runtime scaffold. Business endpoints belong in the existing service folders.
export function createAppServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      sendJson<HealthResponse>(response, 200, { status: "ok" });
      return;
    }
    void (async () => {
      const path = request.url?.split("?")[0] ?? "/";

      // Feature 3: Budget Categories
      // The local server has no verified Cognito identity yet.
      // Passing null ensures protected requests are rejected.
      const budgetHandled = await handleBudgetCategories(request, response, null);

      if (budgetHandled) return;

      // Feature 11: Event Templates (Lulu)
      const templateHandled = await handleTemplates(request.method, path, response);

      if (templateHandled) return;

      sendJson<ErrorResponse>(response, 404, {
        error: "Not found"
      });
    })().catch((error: unknown) => {
      console.error("API request failed", error);

      if (!response.headersSent) {
        sendJson<ErrorResponse>(response, 500, {
          error: "Internal server error"
        });
      } else if (!response.writableEnded) {
        response.end();
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
    process.on(signal, () => server.close(() => { void closePool(); }));
  }
}
