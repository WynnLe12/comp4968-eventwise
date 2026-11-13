import { createServer, type Server } from "node:http";
import { handleTemplates } from "./event-service/handlers/templates";
import { handleBudgetCategories } from "./event-service/handlers/budgetCategories";
import { handleBudgetTotal } from "./event-service/handlers/budgetTotal";
import { closePool } from "./shared/db/pool";
import { testDatabaseConnection } from "./shared/db/db";
import { verifyToken } from "./shared/auth/verifyToken";

import {
  sendJson,
  type ErrorResponse,
  type HealthResponse,
} from "./shared/utils/http";

import {
  createEventHandler,
  type CreateEventDependencies,
} from "./event-service/handlers/createEventHandler";

import {
  listEventsHandler,
  type ListEventsDependencies,
} from "./event-service/handlers/listEventsHandler";

import {
  getEventHandler,
  type GetEventDependencies,
} from "./event-service/handlers/getEventHandler";

import {
  updateEventHandler,
  type UpdateEventDependencies,
} from "./event-service/handlers/updateEventHandler";

export function createAppServer(
  eventDependencies: Partial<CreateEventDependencies> = {},
  listDependencies: Partial<ListEventsDependencies> = {},
  getDependencies: Partial<GetEventDependencies> = {},
  updateDependencies: Partial<UpdateEventDependencies> = {},
): Server {
  // Feature 1: Event Management (Wynn)
  const handleCreateEvent = createEventHandler(eventDependencies);
  const handleListEvents = listEventsHandler(listDependencies);
  const handleGetEvent = getEventHandler(getDependencies);
  const handleUpdateEvent = updateEventHandler(updateDependencies);

  return createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";

    // Feature 1: Create event
    if (request.method === "POST" && path === "/events") {
      void handleCreateEvent(request, response);
      return;
    }

    // Feature 1: List events
    if (request.method === "GET" && path === "/events") {
      void handleListEvents(request, response);
      return;
    }

    const eventMatch = /^\/events\/([^/]+)$/.exec(path);

    // Feature 1: Get event
    if (request.method === "GET" && eventMatch) {
      void handleGetEvent(request, response, eventMatch[1]);
      return;
    }

    // Feature 1: Update event
    if (request.method === "PATCH" && eventMatch) {
      void handleUpdateEvent(request, response, eventMatch[1]);
      return;
    }

    // Health check
    if (request.method === "GET" && path === "/health") {
      sendJson<HealthResponse>(response, 200, {
        status: "ok",
      });
      return;
    }

    // Database health check (Wynn)
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

    // Authentication check (Wynn)
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

    // Feature 3: Budget Categories
    // Authenticate requests using Wynn's Cognito verifier.
    const budgetCategoriesRoute =
      /^\/events\/[^/]+\/budget-categories(?:\/[^/]+)?$/.test(path);

    const budgetTotalRoute =
      /^\/events\/[^/]+\/budget$/.test(path);

    if (budgetCategoriesRoute || budgetTotalRoute) {
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

        let cognitoSub: string;

        try {
          cognitoSub = await verifyToken(token);
        } catch {
          sendJson(response, 401, {
            error: "Invalid or expired authentication token",
          });
          return;
        }

        try {
          const handled = budgetTotalRoute
            ? await handleBudgetTotal(
              request,
              response,
              cognitoSub
            )
            : await handleBudgetCategories(
              request,
              response,
              cognitoSub
            );

          if (!handled) {
            sendJson<ErrorResponse>(response, 404, {
              error: "Not found",
            });
          }
        } catch (error: unknown) {
          console.error("Budget Categories request failed", error);

          if (!response.headersSent) {
            sendJson<ErrorResponse>(response, 500, {
              error: "Internal server error",
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
      })();

      return;
    }

    // Feature 11: Event Templates (Lulu)
    void handleTemplates(request.method, path, response)
      .then((handled) => {
        if (!handled) {
          sendJson<ErrorResponse>(response, 404, {
            error: "Not found",
          });
        }
      })
      .catch((error: unknown) => {
        console.error("Template request failed", error);

        if (!response.headersSent) {
          sendJson<ErrorResponse>(response, 500, {
            error: "Internal server error",
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

  server.listen(port, host, () => {
    console.log(
      `EventWise backend listening on http://${host}:${port}`
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () =>
      server.close(() => {
        void closePool().catch(console.error);
      })
    );
  }
}
