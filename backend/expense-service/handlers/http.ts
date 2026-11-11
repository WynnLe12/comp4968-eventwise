import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, invalid } from "../errors";
import { ExpenseService } from "../services/expenses";
import { parsePaymentQuery } from "../services/payment-validation";
import { parseExpenseQuery, parseId } from "../services/validation";
import type { Authenticate } from "../../shared/auth/cognito";
import { sendJson } from "../../shared/utils/http";

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    request.resume();
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > 16 * 1024) {
        settled = true;
        chunks.length = 0;
        reject(new ApiError(413, "PAYLOAD_TOO_LARGE", "Maximum request body is 16 KiB."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiError(400, "BAD_REQUEST", "Malformed JSON.")); }
    });
    request.on("error", () => { if (!settled) { settled = true; reject(new ApiError(400, "BAD_REQUEST", "Unable to read request.")); } });
    request.on("aborted", () => { if (!settled) { settled = true; reject(new ApiError(400, "BAD_REQUEST", "Request interrupted.")); } });
  });
}

export function expenseHttpHandler(service: ExpenseService, authenticate: Authenticate) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/events\/([^/]+)\/expenses(?:\/([^/]+)(\/payments)?)?$/.exec(url.pathname);
    if (!match) return false;
    // Reserved for commit 6; never interpret 'summary' as an expense ID.
    if (match[2] === "summary") return false;
    try {
      const eventId = parseId(match[1], "eventId", true);
      const expenseId = match[2] === undefined ? undefined : parseId(match[2], "expenseId", true);
      const sub = await authenticate(request.headers.authorization);
      const isPayments = match[3] !== undefined;
      const allowed = isPayments ? ["GET", "POST"] : expenseId ? ["GET", "PATCH", "DELETE"] : ["GET", "POST"];
      if (!allowed.includes(request.method ?? "")) {
        response.setHeader("Allow", allowed.join(", "));
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      if (!(request.method === "GET" && (!expenseId || isPayments)) && url.searchParams.size) invalid("query", "This endpoint does not accept query parameters.");
      if (isPayments && expenseId) {
        if (request.method === "GET") {
          sendJson(response, 200, await service.listPayments(eventId, expenseId, sub, parsePaymentQuery(url.searchParams)));
        } else {
          sendJson(response, 201, { data: await service.recordPayment(eventId, expenseId, sub, await readJson(request)) });
        }
      } else if (request.method === "GET" && !expenseId) {
        sendJson(response, 200, await service.list(eventId, sub, parseExpenseQuery(url.searchParams)));
      } else if (request.method === "GET" && expenseId) {
        sendJson(response, 200, { data: await service.get(eventId, expenseId, sub) });
      } else if (request.method === "POST") {
        const data = await service.create(eventId, sub, await readJson(request));
        response.setHeader("Location", `/events/${eventId}/expenses/${data.expenseId}`);
        sendJson(response, 201, { data });
      } else if (request.method === "PATCH" && expenseId) {
        sendJson(response, 200, { data: await service.update(eventId, expenseId, sub, await readJson(request)) });
      } else if (expenseId) {
        await service.remove(eventId, expenseId, sub);
        response.writeHead(204); response.end();
      }
    } catch (error) {
      request.resume();
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "Unable to complete the request.");
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, apiError.status, { error: { code: apiError.code, message: apiError.message, ...(apiError.fields ? { fields: apiError.fields } : {}) } });
      }
    }
    return true;
  };
}
