// Timeline Lambda (handler: timeline-service/lambda/timeline.handler). Feature 13.
// REST API, Lambda proxy integration (payload v1), Cognito access-token authorizer on
// every method except OPTIONS. Routes are chosen by event.resource, which matches the
// API Gateway resource path exactly. Contract: docs/api/timeline.md.
//
// Organizer routes (Cognito authorizer):
//   GET    /events/{eventId}/timeline           list
//   POST   /events/{eventId}/timeline           create (201 + Location)
//   PATCH  /events/{eventId}/timeline/{itemId}  update (version + optional notify)
//   DELETE /events/{eventId}/timeline/{itemId}  delete (?notify=true)
//   GET    /events/{eventId}/timeline/share     guest link for the event
//
// Public route (NO authorizer; access comes from the signed share token):
//   GET    /guest-timeline/{share}              GUESTS activities + event name/date/venue

import { ApiError } from "../../expense-service/errors";
import { TimelineRepository } from "../repositories/timelineRepository";
import {
  GuestTimelineService,
  TimelineConfigurationError,
} from "../services/guestTimelineService";
import { TimelineService } from "../services/timelineService";

/** The REST API proxy-v1 fields used here. */
export interface TimelineProxyEvent {
  httpMethod: string;
  resource: string;
  headers?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> | null } | null } | null;
}

export interface TimelineProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export const LIST_RESOURCE = "/events/{eventId}/timeline";
export const ITEM_RESOURCE = "/events/{eventId}/timeline/{itemId}";
export const SHARE_RESOURCE = "/events/{eventId}/timeline/share";
export const GUEST_RESOURCE = "/guest-timeline/{share}";

/** Methods per resource, besides OPTIONS. Used for routing and for 405 Allow headers. */
const RESOURCES: Record<string, readonly string[]> = {
  [LIST_RESOURCE]: ["GET", "POST"],
  [ITEM_RESOURCE]: ["PATCH", "DELETE"],
  [SHARE_RESOURCE]: ["GET"],
  [GUEST_RESOURCE]: ["GET"],
};

/** Resources reachable without signing in. Everything else requires authorizer claims. */
const PUBLIC_RESOURCES = new Set([GUEST_RESOURCE]);

export const MAX_BODY_BYTES = 16 * 1024;

type Service = Pick<TimelineService, "list" | "create" | "update" | "delete">;
type GuestService = Pick<GuestTimelineService, "shareLink" | "guestTimeline">;

/**
 * Same checks as vendor-service/lambda/vendors.ts. The claims are trusted ONLY because
 * API Gateway's Cognito authorizer verified the access token, and only Gateway may
 * invoke this function. Never read identity from headers, body or query.
 */
function verifiedSubject(event: TimelineProxyEvent, env: NodeJS.ProcessEnv): string {
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

function header(event: TimelineProxyEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Decodes and parses a write body: 415 if not JSON, 413 if over 16 KiB, 400 if malformed. */
function parseBody(event: TimelineProxyEvent): unknown {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8")) : null;
  if (raw && raw.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  }
  const mediaType = header(event, "content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.");
  }
  if (!raw || raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "The request body isn't valid JSON.");
  }
}

export function createTimelineHandler(
  service: Service = new TimelineService({ repository: new TimelineRepository() }),
  env: NodeJS.ProcessEnv = process.env,
  guest: GuestService = new GuestTimelineService({
    repository: new TimelineRepository(),
    secret: env.TIMELINE_SHARE_SECRET,
    origin: env.GUEST_APP_ORIGIN,
  }),
) {
  return async (event: TimelineProxyEvent): Promise<TimelineProxyResponse> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (env.TIMELINE_CORS_ORIGIN) {
      headers["Access-Control-Allow-Origin"] = env.TIMELINE_CORS_ORIGIN;
      headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
      headers["Vary"] = "Origin";
    }
    const respond = (statusCode: number, body?: unknown, extra: Record<string, string> = {}): TimelineProxyResponse => ({
      statusCode,
      headers: { ...headers, ...extra },
      body: body === undefined ? "" : JSON.stringify(body),
      isBase64Encoded: false,
    });
    const error = (status: number, code: string, message: string, extra?: Record<string, string>) =>
      respond(status, { error: { code, message } }, extra);

    const methods = RESOURCES[event.resource];
    // CORS preflight: no auth, no database. Only for resources this function owns.
    if (event.httpMethod === "OPTIONS" && methods) return respond(204);
    if (!methods) return error(404, "NOT_FOUND", "Not found.");
    if (!methods.includes(event.httpMethod)) {
      return error(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: [...methods, "OPTIONS"].join(", ") });
    }

    try {
      const params = event.pathParameters ?? {};
      if (PUBLIC_RESOURCES.has(event.resource)) {
        return respond(200, await guest.guestTimeline(params.share));
      }

      const sub = verifiedSubject(event, env);
      if (event.resource === SHARE_RESOURCE) {
        return respond(200, await guest.shareLink(params.eventId, sub));
      }

      if (event.resource === LIST_RESOURCE && event.httpMethod === "GET") {
        return respond(200, await service.list(params.eventId, sub));
      }
      if (event.resource === LIST_RESOURCE && event.httpMethod === "POST") {
        const item = await service.create(params.eventId, sub, parseBody(event));
        return respond(201, item, {
          Location: `/events/${encodeURIComponent(item.eventId)}/timeline/${encodeURIComponent(item.itemId)}`,
        });
      }
      if (event.resource === ITEM_RESOURCE && event.httpMethod === "PATCH") {
        return respond(200, await service.update(params.eventId, params.itemId, sub, parseBody(event)));
      }
      // ITEM_RESOURCE DELETE: the notification outcome is not returned with 204.
      await service.delete(params.eventId, params.itemId, sub, event.queryStringParameters);
      return respond(204);
    } catch (caught: unknown) {
      if (caught instanceof ApiError) {
        const { status, code, message, fields } = caught;
        return respond(status, { error: { code, message, ...(fields ? { fields } : {}) } });
      }
      if (caught instanceof TimelineConfigurationError) {
        // Names the missing setting, never its value.
        console.error(`${event.httpMethod} ${event.resource} failed: ${caught.message}`);
        return error(500, "INTERNAL_ERROR", "Unable to complete the request.");
      }
      // Never log request bodies or error details: they may hold personal data.
      console.error(`${event.httpMethod} ${event.resource} failed`, caught instanceof Error ? caught.name : "unknown error");
      return error(500, "INTERNAL_ERROR", "Unable to complete the request.");
    }
  };
}

// The DynamoDB client and MySQL pool are lazy and reused across warm invocations.
export const handler = createTimelineHandler();
