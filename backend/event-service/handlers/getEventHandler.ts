import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken } from "../../shared/auth/verifyToken";
import { sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError, EventNotFoundError, EventAccessDeniedError } from "../services/eventService";

export interface GetEventDependencies {
  verifyToken: (token: string) => Promise<string>;
  service: Pick<EventService, "getById">;
}

export function getEventHandler(dependencies: Partial<GetEventDependencies> = {}) {
  const verify = dependencies.verifyToken ?? verifyToken;
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!token) {
      sendJson(response, 401, { error: "Missing or invalid authentication token" });
      return;
    }
    let cognitoSub: string;
    try {
      cognitoSub = await verify(token);
      if (!cognitoSub || cognitoSub.length > 128) throw new Error("Invalid subject");
    } catch {
      sendJson(response, 401, { error: "Invalid or expired authentication token" });
      return;
    }
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
