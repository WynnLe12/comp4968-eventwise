import type { IncomingMessage, ServerResponse } from "node:http";
import { EmailVerificationUnavailableError, InvalidCognitoAccessTokenError, VerifiedEmailRequiredError, type ResolveVerifiedEmail } from "../../shared/auth/verifiedEmail";
import { readJsonBody, RequestError, sendJson } from "../../shared/utils/http";
import { InvitationInactiveError } from "../repositories/invitationRepository";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError, EventValidationError } from "../services/eventService";
import type { InvitationService } from "../services/invitationService";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";

export type InvitationOperations = Pick<InvitationService, "create" | "list" | "revoke">;

interface InvitationDependencies extends EventAuthentication {
  invitations: InvitationOperations;
}

function invitationError(response: ServerResponse, error: unknown) {
  if (error instanceof RequestError) sendJson(response, error.status, { error: error.message });
  else if (error instanceof EventValidationError) sendJson(response, 400, { error: error.message });
  else if (error instanceof InvalidCognitoAccessTokenError) sendJson(response, 401, { error: "Invalid or expired authentication token" });
  else if (error instanceof VerifiedEmailRequiredError) sendJson(response, 403, { error: "A matching verified email is required" });
  else if (error instanceof EventAccessDeniedError) sendJson(response, 403, { error: error.message });
  else if (error instanceof EventNotFoundError) sendJson(response, 404, { error: error.message });
  else if (error instanceof EventConflictError) sendJson(response, 409, { error: error.message });
  else if (error instanceof InvitationInactiveError) sendJson(response, 410, { error: error.message });
  else if (error instanceof EmailVerificationUnavailableError) sendJson(response, 503, { error: "Unable to verify your email right now. Please try again." });
  else {
    console.error("Event invitation operation failed");
    sendJson(response, 500, { error: "Unable to complete invitation request" });
  }
}

export function eventInvitationHandler(dependencies: InvitationDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, eventId: string, invitationId?: string): Promise<void> => {
    const sub = await authenticateEvent(request, response, dependencies);
    if (sub === undefined) return;
    try {
      if (request.method === "POST") {
        const invitation = await dependencies.invitations.create(eventId, await readJsonBody(request), sub);
        sendJson(response, 201, invitation, { "Cache-Control": "no-store" });
      } else if (request.method === "GET") {
        sendJson(response, 200, await dependencies.invitations.list(eventId, sub));
      } else if (request.method === "DELETE" && invitationId !== undefined) {
        await dependencies.invitations.revoke(eventId, invitationId, sub);
        response.writeHead(204);
        response.end();
      } else {
        sendJson(response, 404, { error: "Not found" });
      }
    } catch (error) {
      invitationError(response, error);
    }
  };
}

export function acceptInvitationHandler(dependencies: EventAuthentication & {
  acceptance: Pick<InvitationService, "accept">;
  resolveVerifiedEmail: ResolveVerifiedEmail;
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const sub = await authenticateEvent(request, response, dependencies);
    if (sub === undefined) return;
    const accessToken = /^Bearer\s+([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!accessToken) {
      sendJson(response, 401, { error: "Missing or invalid authentication token" });
      return;
    }
    try {
      const result = await dependencies.acceptance.accept(await readJsonBody(request), sub, accessToken, dependencies.resolveVerifiedEmail);
      sendJson(response, 200, result);
    } catch (error) {
      invitationError(response, error);
    }
  };
}
