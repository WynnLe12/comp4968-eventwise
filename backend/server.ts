import { createServer, type Server } from "node:http";
import { handleTemplates } from "./event-service/handlers/templates";
import { closePool } from "./shared/db/pool";
import { sendJson, type ErrorResponse, type HealthResponse } from "./shared/utils/http";

// Local runtime scaffold. Business endpoints belong in the existing service folders.
export function createAppServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      sendJson<HealthResponse>(response, 200, { status: "ok" });
      return;
    }
    void handleTemplates(request.method, request.url?.split("?")[0] ?? "/", response)
      .then((handled) => {
        if (!handled) sendJson<ErrorResponse>(response, 404, { error: "Not found" });
      })
      .catch((error: unknown) => {
        console.error("Template request failed", error);
        sendJson<ErrorResponse>(response, 500, { error: "Internal server error" });
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
