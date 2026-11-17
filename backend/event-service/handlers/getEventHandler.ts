import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";
import { sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError, EventNotFoundError, EventAccessDeniedError } from "../services/eventService";

export interface GetEventDependencies extends EventAuthentication {
  service: Pick<EventService, "getById">;
}

export function getEventHandler(dependencies: Partial<GetEventDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      const event = await service.getById(eventId, cognitoSub);
      sendJson(response, 200, event);
    } catch (error) {
      if (error instanceof EventValidationError || error instanceof EventNotFoundError || error instanceof EventAccessDeniedError) {
        const status = error instanceof EventValidationError ? 400 : error instanceof EventNotFoundError ? 404 : 403;
        sendJson(response, status, { error: error.message });
      } else {
        console.error("Event retrieval failed:", error);
        sendJson(response, 500, { error: "Unable to retrieve event" });
      }
    }
  };
}
