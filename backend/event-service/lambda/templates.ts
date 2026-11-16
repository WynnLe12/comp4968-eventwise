import { resolveTemplateRequest, type TemplateRepository } from "../services/templates";

/** Fields consumed from an API Gateway REST API Lambda proxy event (v1). */
export interface TemplatesProxyEvent {
  httpMethod: string;
  path: string;
}

export interface TemplatesProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export function createTemplatesHandler(
  dependencies?: TemplateRepository,
  allowedOrigin = process.env.TEMPLATES_CORS_ORIGIN,
) {
  return async (event: TemplatesProxyEvent): Promise<TemplatesProxyResponse> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers["Access-Control-Allow-Methods"] = "GET,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
    }
    const respond = (statusCode: number, body: object): TemplatesProxyResponse => ({
      statusCode, headers, body: JSON.stringify(body), isBase64Encoded: false,
    });
    const templatePath = /^\/event-templates(?:\/[^/]+)?$/.test(event.path);
    if (event.httpMethod === "OPTIONS" && templatePath) {
      return { ...respond(204, {}), body: "" };
    }
    try {
      const result = await resolveTemplateRequest(event.httpMethod, event.path, dependencies);
      return result ? respond(result.statusCode, result.body) : respond(404, { error: "Not found" });
    } catch (error: unknown) {
      console.error("Template request failed", error);
      return respond(500, { error: "Internal server error" });
    }
  };
}

// The shared database pool is lazy and reused across warm invocations; do not close it here.
export const handler = createTemplatesHandler();
