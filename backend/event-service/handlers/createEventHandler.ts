import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";
import { readJsonBody, RequestError, sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError } from "../services/eventService";

export interface CreateEventDependencies extends EventAuthentication {
  service: Pick<EventService, "create">;
  /** Only the trusted transport adapter supplies profile data. */
  ownerDisplayName?: string;
}

export function createEventHandler(dependencies: Partial<CreateEventDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      const event = await service.create(await readJsonBody(request), cognitoSub, dependencies.ownerDisplayName);
      sendJson(response, 201, event);
    } catch (error) {
      if (error instanceof RequestError || error instanceof EventValidationError) {
        sendJson(response, error instanceof RequestError ? error.status : 400, { error: error.message });
      } else {
        console.error("Event creation failed:", error);
        sendJson(response, 500, { error: "Unable to create event" });
      }
    }
  };
}
