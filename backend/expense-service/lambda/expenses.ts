import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expenseHttpHandler, type ExpenseHttpService } from "../handlers/http";
import { ExpenseService } from "../services/expenses";
import { MySqlExpenseRepository } from "../repositories/mysql-expenses";
import { ApiError } from "../errors";

/** API Gateway REST proxy v1. HTTP API v2 and function URLs are not supported. */
export interface ExpensesProxyEvent {
  httpMethod: string;
  path: string;
  resource?: string;
  pathParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> | null } | null };
}
export interface ExpensesProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

function subject(event: ExpensesProxyEvent, env: NodeJS.ProcessEnv): string {
  // Trust ONLY the Cognito authorizer on Gateway, matching the Events adapter.
  // Deployment must restrict invocation to the intended Gateway and trusted operators;
  // direct invokers can forge claims. Every non-OPTIONS method needs access-token scopes.
  const claims = event.requestContext?.authorizer?.claims;
  const pool = env.COGNITO_USER_POOL_ID;
  const issuer = pool && `https://cognito-idp.${pool.split("_")[0]}.amazonaws.com/${pool}`;
  if (!pool || !env.COGNITO_CLIENT_ID || !claims || claims.token_use !== "access" ||
      claims.client_id !== env.COGNITO_CLIENT_ID || claims.iss !== issuer ||
      typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 128) {
    throw new ApiError(401, "UNAUTHENTICATED", "A valid bearer access token is required.");
  }
  return claims.sub;
}

function requestFrom(event: ExpensesProxyEvent): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.method = event.httpMethod;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) query.append(key, value);
  }
  // Reconstruct duplicates rather than collapsing them: validators reject repeated keys.
  for (const [key, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
    if (values) { query.delete(key); for (const value of values) query.append(key, value); }
  }
  request.url = event.path + (query.size ? `?${query}` : "");
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) request.headers[key.toLowerCase()] = value;
  }
  for (const [key, values] of Object.entries(event.multiValueHeaders ?? {})) {
    if (values) request.headers[key.toLowerCase()] = values.join(",");
  }
  if (event.body) request.push(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8"));
  request.push(null);
  return request;
}

export function createExpensesHandler(dependencies: { service?: ExpenseHttpService; env?: NodeJS.ProcessEnv } = {}) {
  const env = dependencies.env ?? process.env;
  // Repository/pool reused across warm invocations; no database connection on import.
  const service = dependencies.service ?? new ExpenseService(new MySqlExpenseRepository());
  return async (event: ExpensesProxyEvent): Promise<ExpensesProxyResponse> => {
    const headers: Record<string, string> = {};
    if (env.EXPENSES_CORS_ORIGIN) {
      headers["Access-Control-Allow-Origin"] = env.EXPENSES_CORS_ORIGIN;
      headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
      headers["Access-Control-Expose-Headers"] = "Location,Allow";
    }
    const result: ExpensesProxyResponse = { statusCode: 200, headers, body: "", isBase64Encoded: false };
    const failure = (error: ApiError) => {
      result.statusCode = error.status;
      headers["Content-Type"] = "application/json; charset=utf-8";
      result.body = JSON.stringify({ error: { code: error.code, message: error.message } });
      return result;
    };
    let request: IncomingMessage | undefined;
    try {
      // Match exact resources; never intercept Events, Vendors, or Templates routes.
      const match = /^\/events\/([^/?#]+)\/expenses(?:\/([^/?#]+)(\/payments)?)?$/.exec(event.path);
      const summary = match?.[2] === "summary";
      const resource = "/events/{eventId}/expenses" + (summary ? "/summary" : match?.[2] ? "/{expenseId}" : "") + (match?.[3] ?? "");
      if (!match || (summary && match[3]) ||
          (event.resource !== undefined && event.resource !== resource) ||
          (event.pathParameters?.eventId !== undefined && event.pathParameters.eventId !== match[1]) ||
          (event.pathParameters?.expenseId !== undefined && (summary || event.pathParameters.expenseId !== match[2]))) {
        return failure(new ApiError(404, "NOT_FOUND", "Not found."));
      }
      if (event.httpMethod === "OPTIONS") { result.statusCode = 204; return result; }
      const sub = subject(event, env);
      // Deployed handler must use Secrets Manager, never local plaintext fallback.
      if (!dependencies.service && (!env.DB_SECRET_ARN?.trim() || !env.DB_HOST?.trim() || !env.DB_NAME?.trim())) {
        return failure(new ApiError(503, "SERVICE_UNAVAILABLE", "Database is not configured."));
      }
      request = requestFrom(event);
      const response = {
        destroyed: false,
        headersSent: false,
        setHeader(name: string, value: string) { headers[name] = value; return this; },
        writeHead(status: number, values?: Record<string, string>) {
          result.statusCode = status; Object.assign(headers, values); this.headersSent = true; return this;
        },
        end(body?: string) { result.body = body ?? ""; return this; },
      };
      await expenseHttpHandler(service, async () => sub)(request, response as unknown as ServerResponse);
      return result;
    } catch (error) {
      return failure(error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "Unable to complete the request."));
    } finally { request?.destroy(); }
  };
}

export const handler = createExpensesHandler();
