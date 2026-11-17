import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";
import { sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError, EventNotFoundError, EventAccessDeniedError, EventConflictError } from "../services/eventService";

export interface DeleteEventDependencies extends EventAuthentication {
  service: Pick<EventService, "delete">;
}

export function deleteEventHandler(dependencies: Partial<DeleteEventDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      await service.delete(eventId, cognitoSub);
      response.writeHead(204); response.end();
    } catch (error) {
      if (error instanceof EventValidationError || error instanceof EventNotFoundError || error instanceof EventAccessDeniedError || error instanceof EventConflictError) {
        sendJson(response, error instanceof EventNotFoundError ? 404 : error instanceof EventAccessDeniedError ? 403 : error instanceof EventConflictError ? 409 : 400, { error: error.message });
      } else {
        console.error("Event deletion failed:", error);
        sendJson(response, 500, { error: "Unable to delete event" });
      }
    }
  };
}
