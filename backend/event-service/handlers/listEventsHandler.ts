import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";
import { sendJson } from "../../shared/utils/http";
import { EventService } from "../services/eventService";

export interface ListEventsDependencies extends EventAuthentication {
  service: Pick<EventService, "list">;
}

export function listEventsHandler(dependencies: Partial<ListEventsDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      const events = await service.list(cognitoSub);
      sendJson(response, 200, events);
    } catch (error) {
      console.error("Event listing failed:", error);
      sendJson(response, 500, { error: "Unable to list events" });
    }
  };
}
