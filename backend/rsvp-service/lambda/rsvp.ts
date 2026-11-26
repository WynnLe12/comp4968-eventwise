// RSVP API Lambda (handler: rsvp-service/lambda/rsvp.handler). Feature 8.
// REST API (hd63bpgxm8), Lambda proxy integration (payload v1). Routes are chosen by
// event.resource, which matches the API Gateway resource path exactly. Runs OUTSIDE the VPC.
// Contract: docs/api/rsvp.md. Deployment: docs/api/rsvp-lambda.md.
//
// Organizer routes (Cognito authorizer; membership checked through the Event API):
//   GET  /events/{eventId}/rsvp                     RSVP settings (or null)
//   POST /events/{eventId}/rsvp/invitations         save settings + send invitations
//   GET  /events/{eventId}/rsvp/links/{guestId}     one guest's private RSVP link
//
// Public routes (NO authorizer; the signed per-guest token is the credential):
//   GET  /rsvp/{token}                              event details + the guest's answer
//   PUT  /rsvp/{token}                              submit or change the answer

import { ApiError } from "../../expense-service/errors";
import { createSqsPublisher } from "../notifications/publisher";
import { RsvpRepository } from "../repositories/rsvpRepository";
import { RsvpConfigurationError } from "../rsvpLink";
import { createEventAccess } from "../services/eventAccess";
import { RsvpService } from "../services/rsvpService";
import { createStepFunctionsWorkflow } from "../services/workflow";

export interface RsvpProxyEvent {
  httpMethod: string;
  resource: string;
  headers?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> | null } | null } | null;
}

export interface RsvpProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export const SETTINGS_RESOURCE = "/events/{eventId}/rsvp";
export const INVITATIONS_RESOURCE = "/events/{eventId}/rsvp/invitations";
export const LINK_RESOURCE = "/events/{eventId}/rsvp/links/{guestId}";
export const GUEST_RESOURCE = "/rsvp/{token}";

/** Methods per resource, besides OPTIONS. Used for routing and for 405 Allow headers. */
const RESOURCES: Record<string, readonly string[]> = {
  [SETTINGS_RESOURCE]: ["GET"],
  [INVITATIONS_RESOURCE]: ["POST"],
  [LINK_RESOURCE]: ["GET"],
  [GUEST_RESOURCE]: ["GET", "PUT"],
};

export const MAX_BODY_BYTES = 16 * 1024;

type Service = Pick<RsvpService, "getSettings" | "sendInvitations" | "guestLink" | "getForGuest" | "respond">;

/**
 * Same checks as the timeline and vendor Lambdas. The claims are trusted ONLY because API
 * Gateway's Cognito authorizer verified the access token, and only Gateway may invoke this
 * function. Never read identity from headers, body or query.
 */
function verifiedSubject(event: RsvpProxyEvent, env: NodeJS.ProcessEnv): string {
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

function header(event: RsvpProxyEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Decodes and parses a write body: 413 if over 16 KiB, 415 if not JSON, 400 if malformed. */
function parseBody(event: RsvpProxyEvent): unknown {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8")) : null;
  if (raw && raw.length > MAX_BODY_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
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

export function createRsvpHandler(
  env: NodeJS.ProcessEnv = process.env,
  service: Service = new RsvpService({
    repository: new RsvpRepository(),
    eventAccess: createEventAccess(env.EVENT_API_URL),
    workflow: createStepFunctionsWorkflow(env.RSVP_STATE_MACHINE_ARN),
    publish: createSqsPublisher(env.RSVP_EMAIL_QUEUE_URL),
    links: { origin: env.GUEST_APP_ORIGIN, secret: env.RSVP_LINK_SECRET },
  }),
) {
  return async (event: RsvpProxyEvent): Promise<RsvpProxyResponse> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      // RSVP pages carry a private token in the URL; never leak it to other sites.
      "Referrer-Policy": "no-referrer",
    };
    if (env.RSVP_CORS_ORIGIN) {
      headers["Access-Control-Allow-Origin"] = env.RSVP_CORS_ORIGIN;
      headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
      headers["Vary"] = "Origin";
    }
    const respond = (statusCode: number, body?: unknown, extra: Record<string, string> = {}): RsvpProxyResponse => ({
      statusCode,
      headers: { ...headers, ...extra },
      body: body === undefined ? "" : JSON.stringify(body),
      isBase64Encoded: false,
    });
    const error = (status: number, code: string, message: string, extra?: Record<string, string>) =>
      respond(status, { error: { code, message } }, extra);

    const methods = RESOURCES[event.resource];
    // CORS preflight: no auth, no AWS calls. Only for resources this function owns.
    if (event.httpMethod === "OPTIONS" && methods) return respond(204);
    if (!methods) return error(404, "NOT_FOUND", "Not found.");
    if (!methods.includes(event.httpMethod)) {
      return error(405, "METHOD_NOT_ALLOWED", "Method not allowed.", { Allow: [...methods, "OPTIONS"].join(", ") });
    }

    try {
      const params = event.pathParameters ?? {};
      if (event.resource === GUEST_RESOURCE) {
        if (event.httpMethod === "GET") return respond(200, await service.getForGuest(params.token));
        return respond(200, await service.respond(params.token, parseBody(event)));
      }

      const sub = verifiedSubject(event, env);
      const authorization = header(event, "authorization");
      if (event.resource === SETTINGS_RESOURCE) {
        return respond(200, await service.getSettings(params.eventId, authorization));
      }
      if (event.resource === LINK_RESOURCE) {
        return respond(200, await service.guestLink(params.eventId, params.guestId, authorization));
      }
      // INVITATIONS_RESOURCE POST
      return respond(200, await service.sendInvitations(params.eventId, sub, authorization, parseBody(event)));
    } catch (caught: unknown) {
      if (caught instanceof ApiError) {
        const { status, code, message, fields } = caught;
        return respond(status, { error: { code, message, ...(fields ? { fields } : {}) } });
      }
      if (caught instanceof RsvpConfigurationError) {
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

// AWS clients are lazy and reused across warm invocations.
export const handler = createRsvpHandler();
