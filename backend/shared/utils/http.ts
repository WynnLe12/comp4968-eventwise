import type { ServerResponse } from "node:http";

export interface HealthResponse {
  status: "ok";
}

export interface ErrorResponse {
  error: string;
}

export function sendJson<T>(response: ServerResponse, status: number, body: T): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
