import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";
import { sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError, EventNotFoundError, EventAccessDeniedError } from "../services/eventService";

export interface UpdateEventDependencies extends EventAuthentication {
  service: Pick<EventService, "update">;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length <= 65_536) chunks.push(buffer);
  }
  if (length > 65_536) throw new RequestError(413, "Request body is too large");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "Body must be valid JSON");
  }
}

export function updateEventHandler(dependencies: Partial<UpdateEventDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      const event = await service.update(eventId, await readBody(request), cognitoSub);
      sendJson(response, 200, event);
    } catch (error) {
      if (error instanceof RequestError || error instanceof EventValidationError || error instanceof EventNotFoundError || error instanceof EventAccessDeniedError) {
        const status = error instanceof RequestError ? error.status
          : error instanceof EventNotFoundError ? 404 : error instanceof EventAccessDeniedError ? 403 : 400;
        sendJson(response, status, { error: error.message });
      } else {
        console.error("Event update failed:", error);
        sendJson(response, 500, { error: "Unable to update event" });
      }
    }
  };
}
