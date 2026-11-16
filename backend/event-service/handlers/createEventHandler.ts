import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";
import { sendJson } from "../../shared/utils/http";
import { EventService, EventValidationError } from "../services/eventService";

export interface CreateEventDependencies extends EventAuthentication {
  service: Pick<EventService, "create">;
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

export function createEventHandler(dependencies: Partial<CreateEventDependencies> = {}) {
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      const event = await service.create(await readBody(request), cognitoSub);
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
