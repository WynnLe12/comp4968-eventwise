// Tasks Lambda
// REST API, Lambda proxy integration (payload v1), Cognito access-token authorizer on
// every method except OPTIONS. Routes are chosen by event.resource, which matches
// RouteDef.path exactly ("/events/{eventId}/tasks/{taskId}").
// See docs/api/tasks.md.
import { ApiError } from "../../expense-service/errors";
import type { RouteDef } from "../../shared/http/routes";
import { taskRoutes } from "../handlers/taskRoutes";

/** The REST API proxy-v1 fields used here. */
export interface TasksProxyEvent {
  httpMethod: string;
  resource: string;
  pathParameters?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> | null } | null } | null;
}

export interface TasksProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

/**
 * Same checks as event-service/lambda/events.ts. The claims are trusted ONLY because
 * API Gateway's Cognito authorizer verified the access token, and only Gateway may
 * invoke this function. Never read identity from headers, body or query.
 */
function verifiedSubject(event: TasksProxyEvent, env: NodeJS.ProcessEnv): string {
  const claims = event.requestContext?.authorizer?.claims;
  const pool = env.COGNITO_USER_POOL_ID;
  const client = env.COGNITO_CLIENT_ID;
  const issuer = pool && `https://cognito-idp.${pool.split("_")[0]}.amazonaws.com/${pool}`;
  if (!pool || !client || !claims || claims.token_use !== "access" ||
      claims.client_id !== client || claims.iss !== issuer ||
      typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 128) {
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  return claims.sub;
}

function parseBody(event: TasksProxyEvent): unknown {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body isn't valid JSON.");
  }
}

export function createTasksHandler(
  routes: RouteDef[] = taskRoutes,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (event: TasksProxyEvent): Promise<TasksProxyResponse> => {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (env.TASKS_CORS_ORIGIN) {
      headers["Access-Control-Allow-Origin"] = env.TASKS_CORS_ORIGIN;
      headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
    }
    const respond = (statusCode: number, body?: unknown): TasksProxyResponse => ({
      statusCode,
      headers,
      body: body === undefined ? "" : JSON.stringify(body),
      isBase64Encoded: false,
    });

    // CORS preflight: no auth, no database.
    if (event.httpMethod === "OPTIONS") return respond(204);

    const route = routes.find((r) => r.method === event.httpMethod && r.path === event.resource);
    if (!route) return respond(404, { error: { code: "NOT_FOUND", message: "Not found." } });

    try {
      const sub = verifiedSubject(event, env);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
        if (value !== undefined) query.set(key, value);
      }
      const body = route.method === "POST" || route.method === "PATCH" ? parseBody(event) : {};
      const result = await route.handle({
        params: { ...(event.pathParameters ?? {}) },
        query,
        body,
        sub,
      });
      return respond(result.status, result.body);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        const { status, code, message, fields } = error;
        return respond(status, { error: { code, message, ...(fields ? { fields } : {}) } });
      }
      // Never log request bodies: they hold personal details.
      console.error(`${route.method} ${route.path} failed`, error instanceof Error ? error.message : "unknown error");
      return respond(500, { error: { code: "INTERNAL_ERROR", message: "Unable to complete the request." } });
    }
  };
}

// The database pool is lazy and reused across warm invocations. Don't close it here.
export const handler = createTasksHandler();
