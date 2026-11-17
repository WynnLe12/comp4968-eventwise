import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handlePatchRequest } from './patchHandler.mjs';
import { handlePutRequest } from './putHandler.mjs';
import { handleGetRequest } from './getHandler.mjs';
import { handleDeleteRequest } from './deleteHandler.mjs';
import { handleOptionsRequest } from './optionsHandler.mjs';

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
  OPTIONS: handleOptionsRequest,
};

const CLIENT = new DynamoDBClient({});
const DOC_CLIENT = DynamoDBDocumentClient.from(CLIENT);
const TABLE_NAME = process.env.DDB_TABLE_NAME;

// Verify the caller is an OWNER or CO_PLANNER of the event via Lulu's Event API
async function checkEventAccess(eventId, authHeader) {
  if (!eventId) {
    return { allowed: false, statusCode: 400, error: "Missing eventId parameter" };
  }

  if (!authHeader) {
    return { allowed: false, statusCode: 401, error: "Missing Authorization header" };
  }

  try {
    const res = await fetch(`https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod/events/${eventId}`, {
      method: "GET",
      headers: {
        "Authorization": authHeader,
      },
    });

    if (res.status === 403 || res.status === 404) {
      return { allowed: false, statusCode: 403, error: "You do not have access to this event." };
    }

    if (!res.ok) {
      return { allowed: false, statusCode: 500, error: "Failed to verify event access." };
    }

    return { allowed: true };
  } catch (err) {
    return { allowed: false, statusCode: 500, error: `Event access verification error: ${err.message}` };
  }
}

export const handler = async (event, context) => {
  const method = (event.httpMethod ?? event.requestContext?.http?.method ?? "").toUpperCase();

  // Allow OPTIONS preflight immediately without auth or access check
  if (method === "OPTIONS") {
    return handleOptionsRequest(event);
  }

  const requestHandler = REQUEST_HANDLERS[method];
  if (!requestHandler) {
    return {
      statusCode: 405,
      headers: { ...DEFAULT_HEADERS },
      body: JSON.stringify({ error: `${method} method not allowed` })
    };
  }

  // 1. Extract eventId from query string (?eventId=...) or JSON body (for PUT/PATCH/DELETE)
  let eventId = event.queryStringParameters?.eventId;
  if (!eventId && event.body) {
    try {
      const parsed = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      eventId = parsed?.eventId ?? parsed?.guest?.eventId;
    } catch {}
  }

  // 2. Extract Authorization header passed from API Gateway
  const authHeader = event.headers?.Authorization ?? event.headers?.authorization;

  // 3. Event Access Check: Verify caller has membership in Lulu's Event API
  const access = await checkEventAccess(eventId, authHeader);
  if (!access.allowed) {
    return {
      statusCode: access.statusCode,
      headers: { ...DEFAULT_HEADERS },
      body: JSON.stringify({ error: access.error })
    };
  }

  // 4. Authorized: proceed to DynamoDB handler
  try {
    const res = await requestHandler(event, DOC_CLIENT, TABLE_NAME);
    return res;
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...DEFAULT_HEADERS },
      body: JSON.stringify({ error: `${err}` })
    };  
  }
};