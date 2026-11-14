import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken } from "../../shared/auth/verifyToken";
import { sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError, EventNotFoundError, EventAccessDeniedError, EventConflictError } from "../services/eventService";

export interface DeleteEventDependencies {
  verifyToken: (token: string) => Promise<string>;
  service: Pick<EventService, "delete">;
}

export function deleteEventHandler(dependencies: Partial<DeleteEventDependencies> = {}) {
  const verify = dependencies.verifyToken ?? verifyToken;
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!token) { sendJson(response, 401, { error: "Missing or invalid authentication token" }); return; }
    let cognitoSub: string;
    try {
      cognitoSub = await verify(token);
      if (!cognitoSub || cognitoSub.length > 128) throw new Error("Invalid subject");
    } catch { sendJson(response, 401, { error: "Invalid or expired authentication token" }); return; }
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
