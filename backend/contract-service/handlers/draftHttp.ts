import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, invalid } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import type { Authenticate } from "../../shared/auth/cognito";
import { sendJson } from "../../shared/utils/http";
import type { DraftReader } from "../types";
import { parseDraftQuery } from "../services/draftValidation";

/** Shared HTTP entry point for the local server and a future Lambda adapter. */
export function contractDraftHttpHandler(reader: DraftReader, authenticate: Authenticate) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/events\/([^/]+)\/contract-drafts(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Allow", "GET, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204); response.end(); return true;
    }
    try {
      const eventId = parseId(match[1], "eventId", true);
      const draftId = match[2] === undefined ? undefined : parseId(match[2], "draftId", true);
      const sub = await authenticate(request.headers.authorization);
      if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      if (draftId === undefined) {
        sendJson(response, 200, await reader.list(eventId, sub, parseDraftQuery(url.searchParams)));
      } else {
        if (url.searchParams.size) invalid("query", "This endpoint does not accept query parameters.");
        const draft = await reader.get(eventId, draftId, sub);
        if (!draft) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
        sendJson(response, 200, { data: draft });
      }
    } catch (error) {
      request.resume();
      if (!(error instanceof ApiError)) {
        console.error("Contract draft read failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      }
      const failure = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "Unable to load contract drafts.");
      sendJson(response, failure.status, { error: { code: failure.code, message: failure.message,
        ...(failure.fields ? { fields: failure.fields } : {}) } });
    }
    return true;
  };
}
