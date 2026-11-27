import { DraftExtractionService } from "../extraction/draftExtractionService";
import { MySqlDraftExtractionStore } from "../repositories/draftExtractionStore";
import { ApiError } from "../../expense-service/errors";
import { invokeNodeHttpHandler } from "../../shared/lambda/nodeHttpBridge";
import { sendJson } from "../../shared/utils/http";
import { contractDraftHttpHandler } from "../handlers/draftHttp";
import { MySqlDraftReader } from "../repositories/draftReader";
import { MySqlDraftCreator } from "../repositories/draftCreator";
import { MySqlDraftUpdater } from "../repositories/draftUpdater";
import { MySqlDraftDiscarder } from "../repositories/draftDiscarder";
import { MySqlDraftConfirmer } from "../repositories/draftConfirmer";
import type { DraftConfirmer, DraftCreator, DraftDiscarder, DraftExtractor, DraftReader, DraftUpdater } from "../types";

/** API Gateway REST proxy v1; HTTP API v2 and function URLs are not supported. */
export interface ContractsProxyEvent {
  httpMethod: string;
  path: string;
  resource?: string;
  version?: string;
  pathParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { claims?: Record<string, unknown> | null } | null } | null;
}
export interface ContractsProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}
export interface ContractStores {
  reader: DraftReader;
  creator: DraftCreator;
  updater: DraftUpdater;
  discarder: DraftDiscarder;
  confirmer: DraftConfirmer;
  extractor: DraftExtractor;
}

function subject(event: ContractsProxyEvent, env: NodeJS.ProcessEnv): string {
  // Claims are trusted only from the configured Gateway Cognito access-token authorizer.
  // Restrict Lambda invocation to that Gateway and trusted operators; never use body/header identity.
  const claims = event.requestContext?.authorizer?.claims;
  const pool = env.COGNITO_USER_POOL_ID, client = env.COGNITO_CLIENT_ID;
  const issuer = pool && "https://cognito-idp." + pool.split("_")[0] + ".amazonaws.com/" + pool;
  if (!pool || !client || !claims || claims.token_use !== "access" || claims.client_id !== client ||
      claims.iss !== issuer || typeof claims.sub !== "string" || !claims.sub ||
      claims.sub.trim() !== claims.sub || claims.sub.length > 128) {
    throw new ApiError(401, "UNAUTHENTICATED", "A valid bearer access token is required.");
  }
  return claims.sub;
}

function payload(event: ContractsProxyEvent): Buffer {
  const body = event.body ?? "";
  if (typeof body !== "string") throw new ApiError(400, "BAD_REQUEST", "Invalid request body.");
  if (event.isBase64Encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) {
    throw new ApiError(400, "BAD_REQUEST", "Invalid encoded request body.");
  }
  const decoded = Buffer.from(body, event.isBase64Encoded ? "base64" : "utf8");
  if (decoded.length > 65_536) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  return decoded;
}

export function createContractsHandler(dependencies: { stores?: ContractStores; env?: NodeJS.ProcessEnv } = {}) {
  const env = dependencies.env ?? process.env;
  // Lazy repositories and SDK clients are reused across warm invocations; no DB connection on import.
  const stores = dependencies.stores ?? {
    reader: new MySqlDraftReader(), creator: new MySqlDraftCreator(), updater: new MySqlDraftUpdater(),
    discarder: new MySqlDraftDiscarder(), confirmer: new MySqlDraftConfirmer(),
    extractor: new DraftExtractionService(new MySqlDraftExtractionStore()),
  };
  return async (event: ContractsProxyEvent): Promise<ContractsProxyResponse> => {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (env.CONTRACTS_CORS_ORIGIN?.trim()) {
      headers["Access-Control-Allow-Origin"] = env.CONTRACTS_CORS_ORIGIN.trim();
      headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization";
      headers["Access-Control-Expose-Headers"] = "Location,Allow";
    }
    const failure = (error: ApiError): ContractsProxyResponse => ({
      statusCode: error.status, headers, isBase64Encoded: false,
      body: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }),
    });
    try {
      const match = typeof event.path === "string"
        ? /^\/events\/([^/?#]+)\/contract-drafts(?:\/([^/?#]+)(\/(?:discard|confirm|extract))?)?$/.exec(event.path) : null;
      const resource = "/events/{eventId}/contract-drafts" + (match?.[2] ? "/{draftId}" : "") + (match?.[3] ?? "");
      if (!match || event.version === "2.0" || typeof event.httpMethod !== "string" ||
          (event.resource !== undefined && event.resource !== resource) ||
          (event.pathParameters?.eventId !== undefined && event.pathParameters.eventId !== match[1]) ||
          (event.pathParameters?.draftId !== undefined && event.pathParameters.draftId !== match[2])) {
        return failure(new ApiError(404, "NOT_FOUND", "Not found."));
      }
      headers.Allow = match[3] ? "POST, OPTIONS" : match[2] ? "GET, PATCH, OPTIONS" : "GET, POST, OPTIONS";
      if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "", isBase64Encoded: false };
      const sub = subject(event, env);
      // Deployed handlers must use Secrets Manager, with no local plaintext fallback.
      if (!dependencies.stores && (!env.DB_SECRET_ARN?.trim() || !env.DB_HOST?.trim() || !env.DB_NAME?.trim())) {
        return failure(new ApiError(503, "SERVICE_UNAVAILABLE", "Database is not configured."));
      }
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
        if (value !== undefined) query.append(key, value);
      }
      for (const [key, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
        if (values) { query.delete(key); for (const value of values) query.append(key, value); }
      }
      const requestHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(event.headers ?? {})) {
        if (value !== undefined) requestHeaders[name.toLowerCase()] = value;
      }
      for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
        if (values) requestHeaders[name.toLowerCase()] = values.join(",");
      }
      // A separate auth closure per invocation prevents concurrent calls sharing an identity.
      const http = contractDraftHttpHandler(stores.reader, async () => sub, stores.creator,
        stores.updater, stores.discarder, stores.confirmer, stores.extractor);
      const result = await invokeNodeHttpHandler(event.httpMethod, event.path + (query.size ? "?" + query : ""),
        payload(event), async (request, response) => {
          if (!await http(request, response)) sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
        }, requestHeaders);
      return { ...result, headers: { ...headers, ...result.headers }, isBase64Encoded: false };
    } catch (error) {
      if (error instanceof ApiError) return failure(error);
      console.error("Contracts Lambda request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
      return failure(new ApiError(500, "INTERNAL_ERROR", "Unable to complete the request."));
    }
  };
}

export const handler = createContractsHandler();
