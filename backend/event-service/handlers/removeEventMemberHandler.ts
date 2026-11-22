import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../shared/utils/http";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError, EventService, EventValidationError } from "../services/eventService";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";

interface RemoveEventMemberDependencies extends EventAuthentication {
  service: Pick<EventService, "removeMember">;
}

export function removeEventMemberHandler(dependencies: Partial<RemoveEventMemberDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string, memberId: string): Promise<void> => {
    const sub = await authenticateEvent(request, response, dependencies);
    if (sub === undefined) return;
    try {
      await service.removeMember(eventId, memberId, sub);
      response.writeHead(204);
      response.end();
    } catch (error) {
      if (error instanceof EventValidationError) sendJson(response, 400, { error: error.message });
      else if (error instanceof EventAccessDeniedError) sendJson(response, 403, { error: error.message });
      else if (error instanceof EventNotFoundError) sendJson(response, 404, { error: error.message });
      else if (error instanceof EventConflictError) sendJson(response, 409, { error: error.message });
      else {
        console.error("Event member removal failed");
        sendJson(response, 500, { error: "Unable to remove event member" });
      }
    }
  };
}
