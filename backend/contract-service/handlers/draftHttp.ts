import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, invalid } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import type { Authenticate } from "../../shared/auth/cognito";
import { readJsonBody, RequestError, sendJson } from "../../shared/utils/http";
import type { DraftCreator, DraftReader } from "../types";
import { parseCreateDraft, parseDraftQuery } from "../services/draftValidation";

/** Shared HTTP entry point for the local server and a future Lambda adapter. */
export function contractDraftHttpHandler(reader: DraftReader, authenticate: Authenticate, creator: DraftCreator) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/events\/([^/]+)\/contract-drafts(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Allow", match[2] === undefined ? "GET, POST, OPTIONS" : "GET, OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204); response.end(); return true;
    }
    try {
      const eventId = parseId(match[1], "eventId", true);
      const draftId = match[2] === undefined ? undefined : parseId(match[2], "draftId", true);
      const sub = await authenticate(request.headers.authorization);
      if (request.method === "POST" && draftId === undefined) {
        if (url.searchParams.size) invalid("query", "This endpoint does not accept query parameters.");
        const input = parseCreateDraft(await readJsonBody(request));
        const result = await creator.create(eventId, input.documentId, sub);
        response.setHeader("Location", "/events/" + eventId + "/contract-drafts/" + result.draftId);
        sendJson(response, result.created ? 201 : 200, { data: { draftId: result.draftId }, created: result.created });
        return true;
      }
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
      if (!(error instanceof ApiError) && !(error instanceof RequestError)) {
        console.error("Contract draft request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      }
      const failure = error instanceof ApiError ? error : error instanceof RequestError
        ? new ApiError(error.status, error.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : error.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", error.message)
        : new ApiError(500, "INTERNAL_ERROR", request.method === "POST" ? "Unable to create the contract draft." : "Unable to load contract drafts.");
      sendJson(response, failure.status, { error: { code: failure.code, message: failure.message,
        ...(failure.fields ? { fields: failure.fields } : {}) } });
    }
    return true;
  };
}
