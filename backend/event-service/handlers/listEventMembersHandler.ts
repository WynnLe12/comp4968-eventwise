import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../shared/utils/http";
import { EventAccessDeniedError, EventService, EventValidationError } from "../services/eventService";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";

export interface ListEventMembersDependencies extends EventAuthentication {
  service: Pick<EventService, "listMembers">;
}

export function listEventMembersHandler(dependencies: Partial<ListEventMembersDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      sendJson(response, 200, await service.listMembers(eventId, cognitoSub), { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof EventValidationError || error instanceof EventAccessDeniedError) {
        sendJson(response, error instanceof EventValidationError ? 400 : 403, { error: error.message });
      } else {
        console.error("Event member listing failed");
        sendJson(response, 500, { error: "Unable to list event members" });
      }
    }
  };
}
