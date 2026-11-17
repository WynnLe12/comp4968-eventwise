import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handlePatchRequest } from "./patchHandler.mjs";
import { handlePutRequest } from "./putHandler.mjs";
import { handleGetRequest } from "./getHandler.mjs";
import { handleDeleteRequest } from "./deleteHandler.mjs";
import { handleOptionsRequest } from "./optionsHandler.mjs";

export const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
};

const REQUEST_HANDLERS = {
  GET: handleGetRequest,
  PUT: handlePutRequest,
  PATCH: handlePatchRequest,
  DELETE: handleDeleteRequest,
};

const DOC_CLIENT = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.DDB_TABLE_NAME;
const EVENT_API = "https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod";

const respond = (statusCode, error) => ({
  statusCode,
  headers: { ...DEFAULT_HEADERS },
  body: JSON.stringify({ error }),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEventId(value) {
  return typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n;
}

async function checkEventAccess(eventId, authHeader) {
  if (!/^Bearer [^\s]+$/i.test(authHeader ?? "")) {
    return { allowed: false, statusCode: 401, error: "A valid bearer access token is required." };
  }
  try {
    const response = await fetch(
      EVENT_API + "/events/" + encodeURIComponent(eventId),
      { headers: { Authorization: authHeader } },
    );
    if (response.status === 401) {
      return { allowed: false, statusCode: 401, error: "Invalid or expired authentication token." };
    }
    if (response.status === 403 || response.status === 404) {
      return { allowed: false, statusCode: 403, error: "You do not have access to this event." };
    }
    if (!response.ok) {
      return { allowed: false, statusCode: 502, error: "Unable to verify event access. Please try again." };
    }
    return { allowed: true };
  } catch {
    console.error("Guest event-access verification failed.");
    return { allowed: false, statusCode: 502, error: "Unable to verify event access. Please try again." };
  }
}

export const handler = async (event) => {
  const method = String(event.httpMethod ?? event.requestContext?.http?.method ?? "").toUpperCase();
  if (method === "OPTIONS") return handleOptionsRequest(event);
  if (!Object.hasOwn(REQUEST_HANDLERS, method)) return respond(405, "Method not allowed.");

  let body = {};
  try {
    if (event.body !== undefined && event.body !== null && event.body !== "") {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      body = typeof raw === "string" ? JSON.parse(raw) : raw;
    }
    if (!isObject(body) || (Object.hasOwn(body, "guest") && !isObject(body.guest))) {
      return respond(400, "Request body and guest must be JSON objects.");
    }
  } catch {
    return respond(400, "Request body must be valid JSON.");
  }

  const queryId = event.queryStringParameters?.eventId;
  const eventId = method === "GET" ? queryId : body.guest?.eventId;
  if (!validEventId(eventId)) {
    return respond(400, method === "GET"
      ? "A valid eventId query parameter is required."
      : "A valid guest.eventId is required.");
  }

  const suppliedIds = [
    queryId,
    body.eventId,
    body.guest?.eventId,
    ...(event.multiValueQueryStringParameters?.eventId ?? []),
  ].filter(value => value !== undefined);

  if (suppliedIds.some(value => value !== eventId)) {
    return respond(400, "Conflicting event IDs in request.");
  }

  const authHeader = Object.entries(event.headers ?? {})
    .find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const access = await checkEventAccess(eventId, authHeader);
  if (!access.allowed) return respond(access.statusCode, access.error);

  // Existing handlers receive the same event ID that was authorized.
  const normalizedEvent = {
    ...event,
    httpMethod: method,
    queryStringParameters: { ...event.queryStringParameters, eventId },
    body: JSON.stringify(method === "GET"
      ? body
      : { ...body, guest: { ...body.guest, eventId } }),
    isBase64Encoded: false,
  };

  try {
    return await REQUEST_HANDLERS[method](normalizedEvent, DOC_CLIENT, TABLE_NAME);
  } catch (error) {
    console.error("Guest operation failed:", error instanceof Error ? error.name : "UnknownError");
    return respond(500, "Unable to complete the guest request. Please try again.");
  }
};
