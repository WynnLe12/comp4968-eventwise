import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken } from "../../shared/auth/verifyToken";
import { sendJson } from "../../shared/utils/http";
import { EventService } from "../services/eventService";

export interface ListEventsDependencies {
  verifyToken: (token: string) => Promise<string>;
  service: Pick<EventService, "list">;
}

export function listEventsHandler(dependencies: Partial<ListEventsDependencies> = {}) {
  const verify = dependencies.verifyToken ?? verifyToken;
  const service = dependencies.service ?? new EventService();
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
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
      const events = await service.list(cognitoSub);
      sendJson(response, 200, events);
    } catch (error) {
      console.error("Event listing failed:", error);
      sendJson(response, 500, { error: "Unable to list events" });
    }
  };
}
