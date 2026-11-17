import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEventHandler } from "../handlers/createEventHandler";
import { listEventsHandler } from "../handlers/listEventsHandler";
import { getEventHandler } from "../handlers/getEventHandler";
import { updateEventHandler } from "../handlers/updateEventHandler";
import { deleteEventHandler } from "../handlers/deleteEventHandler";
import { EventService } from "../services/eventService";

/** The REST API proxy-v1 fields consumed here; no HTTP API v2 fallback. */
export interface EventsProxyEvent {
  httpMethod: string;
  path: string;
  resource?: string;
  pathParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> | null } | null };
}

export interface EventsProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export type EventsService = Pick<EventService, "list" | "getById" | "create" | "update" | "delete">;
export interface EventsLambdaDependencies {
  service?: EventsService;
  env?: NodeJS.ProcessEnv;
}

function verifiedSubject(event: EventsProxyEvent, env: NodeJS.ProcessEnv): string {
  // These claims are trusted ONLY because Gateway authenticates each Events method
  // and the function's invoke policy excludes arbitrary callers/function URLs.
  // Never decode Authorization or use principalId, headers, body, or query identity.
  const claims = event.requestContext?.authorizer?.claims;
  const pool = env.COGNITO_USER_POOL_ID;
  const client = env.COGNITO_CLIENT_ID;
  const issuer = pool && `https://cognito-idp.${pool.split("_")[0]}.amazonaws.com/${pool}`;
  if (!pool || !client || !claims || claims.token_use !== "access" ||
      claims.client_id !== client || claims.iss !== issuer ||
      typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 128) {
    throw new Error("Invalid authorizer identity");
  }
  return claims.sub;
}

function requestFrom(event: EventsProxyEvent): IncomingMessage {
  // A real readable IncomingMessage preserves the existing byte-based body parser.
  // Socket is never connected; no HTTP server or network listener is started.
  const request = new IncomingMessage(new Socket());
  request.method = event.httpMethod;
  request.url = event.path;
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) request.headers[name.toLowerCase()] = value;
  }
  // REST proxy multi-value headers take precedence over the single-value view.
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    if (values?.length) request.headers[name.toLowerCase()] = values.join(",");
  }
  if (event.body) request.push(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8"));
  request.push(null);
  return request;
}

export function createEventsHandler(dependencies: EventsLambdaDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const service = dependencies.service ?? new EventService();
  return async (event: EventsProxyEvent): Promise<EventsProxyResponse> => {
    const headers: Record<string, string> = {};
    if (env.EVENTS_CORS_ORIGIN) {
      headers["Access-Control-Allow-Origin"] = env.EVENTS_CORS_ORIGIN;
      headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
    }
    const result: EventsProxyResponse = { statusCode: 200, headers, body: "", isBase64Encoded: false };
    const json = (status: number, error: string) => {
      result.statusCode = status;
      headers["Content-Type"] = "application/json; charset=utf-8";
      result.body = JSON.stringify({ error });
      return result;
    };
    const match = /^\/events\/([^/]+)$/.exec(event.path);
    const collection = event.path === "/events";
    const expectedResource = collection ? "/events" : "/events/{eventId}";
    if ((!collection && !match) ||
        (event.resource !== undefined && event.resource !== expectedResource) ||
        (match && event.pathParameters?.eventId !== undefined && event.pathParameters.eventId !== match[1])) {
      return json(404, "Not found");
    }
    if (event.httpMethod === "OPTIONS") { result.statusCode = 204; return result; }
    const supported = collection ? ["GET", "POST"] : ["GET", "PATCH", "DELETE"];
    if (!supported.includes(event.httpMethod)) return json(404, "Not found");

    // Capture exactly the writeHead/end operations used by the existing handlers.
    const response = {
      writeHead(status: number, values?: Record<string, string>) {
        result.statusCode = status;
        Object.assign(headers, values);
        return this;
      },
      end(body?: string) { result.body = body ?? ""; return this; },
    };
    let request: IncomingMessage | undefined;
    try {
      request = requestFrom(event);
      const options = {
        service,
        resolveIdentity: async () => verifiedSubject(event, env),
      };
      // Require secret mode for the deployed service; never fall back to .env credentials.
      // Injected services are used by isolated tests and need no database configuration.
      if (!dependencies.service) {
        try { verifiedSubject(event, env); } catch { return json(401, "Invalid or expired authentication token"); }
        if (!env.DB_SECRET_ARN?.trim() || !env.DB_HOST?.trim() || !env.DB_NAME?.trim() || env.DYNAMODB_ENDPOINT) {
          console.error("Events Lambda requires RDS secret configuration and the AWS DynamoDB endpoint");
          return json(500, "Internal server error");
        }
      }
      // The narrow response assertion is the only transport shim. Body parsing,
      // validation, serialization, status mapping and authorization stay in handlers.
      const output = response as unknown as ServerResponse;
      if (collection && event.httpMethod === "GET") await listEventsHandler(options)(request, output);
      else if (collection) await createEventHandler(options)(request, output);
      else if (event.httpMethod === "GET") await getEventHandler(options)(request, output, match![1]);
      else if (event.httpMethod === "PATCH") await updateEventHandler(options)(request, output, match![1]);
      else await deleteEventHandler(options)(request, output, match![1]);
      return result;
    } catch {
      console.error("Events Lambda adapter failed");
      return json(500, "Internal server error");
    } finally {
      request?.destroy();
    }
  };
}

// Shared service/pool/SDK clients survive warm invocations; identity is invocation-local.
export const handler = createEventsHandler();
