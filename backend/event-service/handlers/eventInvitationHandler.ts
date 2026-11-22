import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, RequestError, sendJson } from "../../shared/utils/http";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError, EventValidationError } from "../services/eventService";
import { InvitationService } from "../services/invitationService";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";

export type InvitationOperations = Pick<InvitationService, "create" | "list" | "revoke">;

interface InvitationDependencies extends EventAuthentication {
  invitations: InvitationOperations;
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
      if (error instanceof RequestError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof EventValidationError) sendJson(response, 400, { error: error.message });
      else if (error instanceof EventAccessDeniedError) sendJson(response, 403, { error: error.message });
      else if (error instanceof EventNotFoundError) sendJson(response, 404, { error: error.message });
      else if (error instanceof EventConflictError) sendJson(response, 409, { error: error.message });
      else {
        console.error("Event invitation operation failed");
        sendJson(response, 500, { error: "Unable to complete invitation request" });
      }
    }
  };
}
