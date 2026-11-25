import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEventHandler } from "../handlers/createEventHandler";
import { listEventsHandler } from "../handlers/listEventsHandler";
import { listEventMembersHandler } from "../handlers/listEventMembersHandler";
import { removeEventMemberHandler } from "../handlers/removeEventMemberHandler";
import { getEventHandler } from "../handlers/getEventHandler";
import { updateEventHandler } from "../handlers/updateEventHandler";
import { deleteEventHandler } from "../handlers/deleteEventHandler";
import { dashboardHandler } from "../handlers/dashboardHandler";
import { acceptInvitationHandler, eventInvitationHandler, type InvitationOperations } from "../handlers/eventInvitationHandler";
import { EventService } from "../services/eventService";
import { DashboardService } from "../services/dashboardService";
import { normalizeProfileDisplayName } from "../../shared/auth/profileDisplayName";
import { InvitationService } from "../services/invitationService";
import {
  eventCreationAuthorizerVersion, eventCreationRoute, invitationAcceptancePath, invitationAcceptanceRoute, invitationAuthorizerVersion, invitationBearer,
  validInvitationSubject, type VerifiedInvitationIdentity,
} from "../invitationAcceptanceAuth";
import { normalizeInvitationEmail } from "../invitationEmail";

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
  requestContext?: {
    accountId?: string;
    apiId?: string;
    stage?: string;
    authorizer?: ({ claims?: Record<string, unknown> | null } & Record<string, unknown>) | null;
  };
}

export interface EventsProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export type EventsService = Pick<EventService, "list" | "getById" | "create" | "update" | "delete" | "listMembers" | "removeMember">;
export interface EventsLambdaDependencies {
  service?: EventsService;
  invitations?: InvitationOperations;
  acceptance?: Pick<InvitationService, "accept">;
  dashboard?: Pick<DashboardService, "get">;
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

function verifiedEventCreator(event: EventsProxyEvent, route: ReturnType<typeof eventCreationRoute>) {
  const context = event.requestContext;
  const authorizer = context?.authorizer;
  if (!route || !context || context.accountId !== route.accountId || context.apiId !== route.apiId || context.stage !== route.stage ||
      !authorizer || authorizer.claims !== undefined || authorizer.eventCreationAuthVersion !== eventCreationAuthorizerVersion ||
      !validInvitationSubject(authorizer.eventCreationSub) || authorizer.principalId !== authorizer.eventCreationSub) return undefined;
  return { sub: authorizer.eventCreationSub, displayName: normalizeProfileDisplayName(authorizer.eventOwnerDisplayName) };
}

function verifiedInvitationIdentity(event: EventsProxyEvent, route: ReturnType<typeof invitationAcceptanceRoute>): VerifiedInvitationIdentity | undefined {
  const context = event.requestContext;
  const authorizer = context?.authorizer;
  // Only the exact Gateway integration can invoke this Events target. Context fields
  // validate the contract, while the deployment's invoke policy establishes provenance.
  if (!route || !context || context.accountId !== route.accountId || context.apiId !== route.apiId || context.stage !== route.stage ||
      !authorizer || authorizer.claims !== undefined || authorizer.invitationAuthVersion !== invitationAuthorizerVersion ||
      !validInvitationSubject(authorizer.invitationSub) || authorizer.principalId !== authorizer.invitationSub ||
      typeof authorizer.invitationVerifiedEmail !== "string" ||
      normalizeInvitationEmail(authorizer.invitationVerifiedEmail) !== authorizer.invitationVerifiedEmail) return undefined;

  const singleHeaders = Object.entries(event.headers ?? {}).filter(([name]) => name.toLowerCase() === "authorization");
  const multiHeaders = Object.entries(event.multiValueHeaders ?? {}).filter(([name]) => name.toLowerCase() === "authorization");
  if (singleHeaders.length > 1 || multiHeaders.length > 1) return undefined;
  const single = singleHeaders[0]?.[1];
  const values = multiHeaders[0]?.[1];
  if (values && (values.length !== 1 || (single !== undefined && single !== values[0]))) return undefined;
  if (!invitationBearer(values?.[0] ?? single)) return undefined;

  return {
    sub: authorizer.invitationSub,
    email: authorizer.invitationVerifiedEmail,
    displayName: normalizeProfileDisplayName(authorizer.invitationDisplayName),
  };
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
  const invitationService = new InvitationService(undefined, env);
  const invitations = dependencies.invitations ?? invitationService;
  const acceptance = dependencies.acceptance ?? invitationService;
  const dashboard = dependencies.dashboard ?? new DashboardService();
  const acceptanceRoute = invitationAcceptanceRoute(env.EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN);
  const creationRoute = eventCreationRoute(env.EVENTS_CREATE_METHOD_ARN);
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
    const membersMatch = /^\/events\/([^/]+)\/members(?:\/([^/]+))?$/.exec(event.path);
    const memberId = membersMatch?.[2];
    const invitationsMatch = /^\/events\/([^/]+)\/invitations(?:\/([^/]+))?$/.exec(event.path);
    const invitationId = invitationsMatch?.[2];
    const dashboardMatch = /^\/events\/([^/]+)\/dashboard$/.exec(event.path);
    const match = membersMatch ?? invitationsMatch ?? dashboardMatch ?? /^\/events\/([^/]+)$/.exec(event.path);
    const collection = event.path === "/events";
    const accepting = event.path === invitationAcceptancePath;
    let expectedResource = collection ? "/events" : "/events/{eventId}";
    let supported = collection ? ["GET", "POST"] : ["GET", "PATCH", "DELETE"];
    if (accepting) {
      expectedResource = invitationAcceptancePath;
      supported = ["POST"];
      headers["Cache-Control"] = "no-store";
    } else if (membersMatch) {
      expectedResource += memberId === undefined ? "/members" : "/members/{memberId}";
      supported = memberId === undefined ? ["GET"] : ["DELETE"];
    } else if (invitationsMatch) {
      expectedResource += invitationId === undefined ? "/invitations" : "/invitations/{invitationId}";
      supported = invitationId === undefined ? ["GET", "POST"] : ["DELETE"];
    } else if (dashboardMatch) {
      expectedResource += "/dashboard";
      supported = ["GET"];
    }
    const parameterId = event.pathParameters?.eventId;
    if ((!accepting && !collection && !match) ||
        (event.resource !== undefined && event.resource !== expectedResource) ||
        (accepting && event.pathParameters != null && Object.keys(event.pathParameters).length > 0) ||
        (match && parameterId !== undefined && parameterId !== match[1]) ||
        ((membersMatch || invitationsMatch || dashboardMatch) && event.pathParameters != null && parameterId === undefined) ||
        (dashboardMatch && event.pathParameters != null && Object.keys(event.pathParameters).length !== 1) ||
        (memberId !== undefined && event.pathParameters != null &&
          (event.pathParameters.memberId !== memberId || Object.keys(event.pathParameters).length !== 2)) ||
        (invitationsMatch && event.pathParameters != null &&
          (event.pathParameters.invitationId !== invitationId ||
            Object.keys(event.pathParameters).length !== (invitationId === undefined ? 1 : 2)))) {
      return json(404, "Not found");
    }
    if (event.httpMethod === "OPTIONS") { result.statusCode = 204; return result; }
    if (!supported.includes(event.httpMethod)) return json(404, "Not found");
    const identity = accepting ? verifiedInvitationIdentity(event, acceptanceRoute) : undefined;
    if (accepting && !identity) return json(401, "Invalid or expired authentication token");
    const creator = collection && event.httpMethod === "POST" ? verifiedEventCreator(event, creationRoute) : undefined;

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
        resolveIdentity: async () => creator?.sub ?? verifiedSubject(event, env),
      };
      // Require secret mode for the deployed service; never fall back to .env credentials.
      // Injected services are used by isolated tests and need no database configuration.
      const injected = accepting ? dependencies.acceptance : invitationsMatch ? dependencies.invitations
        : dashboardMatch ? dependencies.dashboard : dependencies.service;
      if (!injected) {
        if (!accepting && !creator) {
          try { verifiedSubject(event, env); } catch { return json(401, "Invalid or expired authentication token"); }
        }
        if (!env.DB_SECRET_ARN?.trim() || !env.DB_HOST?.trim() || !env.DB_NAME?.trim() || env.DYNAMODB_ENDPOINT) {
          console.error("Events Lambda requires RDS secret configuration and the AWS DynamoDB endpoint");
          return json(500, "Internal server error");
        }
      }
      // The narrow response assertion is the only transport shim. Body parsing,
      // validation, serialization, status mapping and authorization stay in handlers.
      const output = response as unknown as ServerResponse;
      if (identity) await acceptInvitationHandler(acceptance)(request, output, identity);
      else if (invitationsMatch) await eventInvitationHandler({ ...options, invitations })(request, output, invitationsMatch[1], invitationId);
      else if (dashboardMatch) await dashboardHandler({ ...options, service: dashboard })(request, output, dashboardMatch[1]);
      else if (collection && event.httpMethod === "GET") await listEventsHandler(options)(request, output);
      else if (collection) await createEventHandler({ ...options, ownerDisplayName: creator?.displayName })(request, output);
      else if (membersMatch && memberId !== undefined) await removeEventMemberHandler(options)(request, output, membersMatch[1], memberId);
      else if (membersMatch) await listEventMembersHandler(options)(request, output, membersMatch[1]);
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
