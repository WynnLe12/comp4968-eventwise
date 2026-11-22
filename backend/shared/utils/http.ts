import type { IncomingMessage, ServerResponse } from "node:http";

export interface HealthResponse {
  status: "ok";
}

export interface ErrorResponse {
  error: string;
}

export function sendJson<T>(response: ServerResponse, status: number, body: T, headers?: Record<string, string>): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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
