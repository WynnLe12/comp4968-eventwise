// One route shape for every feature in the Event API Lambda.
// Routes don't know whether they run on Lambda or the local server: an adapter
// (handler.ts for Lambda, server.ts locally) turns the request into an ApiRequest,
// verifies the user, and turns the result or an ApiError into the HTTP response.

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiRequest {
  /** Path parameters by name, always strings: { eventId: "1", vendorId: "6" }. */
  params: Record<string, string | undefined>;
  query: URLSearchParams;
  /** Parsed JSON body; {} when the request has none. */
  body: unknown;
  /** The verified Cognito user. The adapter returns 401 before a route runs without one. */
  sub: string;
}

export interface ApiResponse {
  status: number;
  /** Sent as JSON. Leave out for 204. */
  body?: unknown;
}

export interface RouteDef {
  method: HttpMethod;
  /** Exactly the API Gateway resource path, e.g. "/events/{eventId}/vendors/{vendorId}". */
  path: string;
  handle(request: ApiRequest): Promise<ApiResponse>;
}

/** A positive whole-number ID as text (BIGINT UNSIGNED), or null if it isn't one. */
export function idParam(value: string | undefined): string | null {
  return value !== undefined && /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
    ? value
    : null;
}
