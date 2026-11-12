
import { createServer, type Server } from "node:http";
import {
  sendJson,
  type ErrorResponse,
  type HealthResponse,
} from "./shared/utils/http";
import { testDatabaseConnection } from "./shared/db/db";
import { verifyToken } from "./shared/auth/verifyToken";

import { createEventHandler, type CreateEventDependencies } from "./event-service/handlers/createEventHandler";

export function createAppServer(eventDependencies: Partial<CreateEventDependencies> = {}): Server {
  const handleCreateEvent = createEventHandler(eventDependencies);
  return createServer((request, response) => {
    const path = request.url?.split("?")[0];

    if (request.method === "POST" && path === "/events") {
      void handleCreateEvent(request, response);
      return;
    }

    // Existing health check
    if (request.method === "GET" && path === "/health") {
      sendJson<HealthResponse>(response, 200, { status: "ok" });
      return;
    }

    // New database health check
    if (request.method === "GET" && path === "/health/db") {
      void (async () => {
        try {
          await testDatabaseConnection();

          sendJson(response, 200, {
            status: "ok",
            database: "connected",
          });
        } catch (error) {
          console.error("Database connection failed:", error);

          sendJson(response, 503, {
            status: "error",
            database: "unavailable",
          });
        }
      })();

      return;
    }

    // route require access token from Cognito
    if (request.method === "GET" && path === "/auth/me") {
      void (async () => {
        const authorization = request.headers.authorization;

        if (!authorization?.startsWith("Bearer ")) {
          sendJson(response, 401, {
            error: "Missing authentication token",
          });
          return;
        }

        const token = authorization.slice(7).trim();

        if (!token) {
          sendJson(response, 401, {
            error: "Missing authentication token",
          });
          return;
        }

        try {
          const cognitoSub = await verifyToken(token);

          sendJson(response, 200, {
            authenticated: true,
            userId: cognitoSub,
          });
        } catch {
          sendJson(response, 401, {
            error: "Invalid or expired authentication token",
          });
        }
      })();

      return;
    }


    sendJson<ErrorResponse>(response, 404, {
      error: "Not found",
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

  server.listen(port, host, () => {
    console.log(
      `EventWise backend listening on http://${host}:${port}`
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close());
  }
}
