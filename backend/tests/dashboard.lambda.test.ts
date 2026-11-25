import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventsHandler, type EventsProxyEvent, type EventsService } from "../event-service/lambda/events";
import { EventAccessDeniedError, EventNotFoundError, EventValidationError } from "../event-service/services/eventService";
import type { Dashboard, DashboardService } from "../event-service/services/dashboardService";
import { ApiError } from "../expense-service/errors";

const env = {
  COGNITO_USER_POOL_ID: "us-west-2_testpool", COGNITO_CLIENT_ID: "testclient",
  EVENTS_CORS_ORIGIN: "https://organizer.example",
};
const id = "18446744073709551615";
const path = `/events/${id}/dashboard`;

const dashboard = {
  eventId: id, asOfDate: "2026-06-10",
  budget: { eventBudget: "5000.00", allocatedBudget: "5000.00", committedTotal: "0.00", paidTotal: "0.00",
    outstandingTotal: "0.00", remainingBudget: "5000.00", isOverBudget: false, categories: [] },
  payments: { windowDays: 7, overdueTotal: "0.00", overdueCount: 0, upcomingTotal: "0.00", upcomingCount: 0, items: [] },
  guests: null,
  tasks: { total: 0, completed: 0, overdue: 0, percentComplete: 0, nextDue: [] },
  unavailable: ["guests"],
} satisfies Dashboard;

function proxy(method = "GET", requestPath = path, sub: string | null = "owner"): EventsProxyEvent {
  return {
    httpMethod: method, path: requestPath, resource: "/events/{eventId}/dashboard",
    pathParameters: { eventId: requestPath.split("/")[2] ?? "" },
    headers: { Authorization: "Bearer deliberately-not-decoded" },
    requestContext: sub === null ? undefined : { authorizer: { claims: {
      sub, token_use: "access", client_id: env.COGNITO_CLIENT_ID,
      iss: `https://cognito-idp.us-west-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
      scope: "aws.cognito.signin.user.admin",
    } } },
    body: null, isBase64Encoded: false,
  };
}

function setup(get: Pick<DashboardService, "get">["get"] = async () => dashboard) {
  const calls: unknown[][] = [];
  const events = new Proxy({}, { get: () => () => { throw new Error("Events service must not run"); } }) as EventsService;
  const handler = createEventsHandler({
    env, service: events,
    dashboard: { get: async (eventId, sub) => { calls.push([eventId, sub]); return get(eventId, sub); } },
  });
  return { handler, calls };
}

test("GET dashboard returns the dashboard for the verified caller, uncached, with CORS", async () => {
  const { handler, calls } = setup();
  const result = await handler(proxy());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), dashboard);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Access-Control-Allow-Origin"], env.EVENTS_CORS_ORIGIN);
  // The ID stays an exact string and the identity comes only from the authorizer claims.
  assert.deepEqual(calls, [[id, "owner"]]);
});

test("service errors map to 400 / 404 / 403 / 500 without leaking details", async (t) => {
  t.mock.method(console, "error", () => {});
  const cases: [Error, number, string][] = [
    [new EventValidationError("eventId must be a positive unsigned BIGINT"), 400, "eventId must be a positive unsigned BIGINT"],
    [new EventNotFoundError("Event not found"), 404, "Event not found"],
    [new EventAccessDeniedError("You do not have access to this event"), 403, "You do not have access to this event"],
    [new ApiError(403, "FORBIDDEN", "You do not have access to this event."), 403, "You do not have access to this event"],
    [new Error("private SQL detail"), 500, "Unable to load the event dashboard"],
  ];
  for (const [error, status, message] of cases) {
    const { handler } = setup(async () => { throw error; });
    const result = await handler(proxy());
    assert.equal(result.statusCode, status);
    assert.deepEqual(JSON.parse(result.body), { error: message });
    assert.doesNotMatch(result.body, /private SQL/);
  }
});

test("missing or untrusted identity is 401 before the dashboard runs", async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(proxy("GET", path, null))).statusCode, 401);
  const idToken = proxy();
  idToken.requestContext!.authorizer!.claims!.token_use = "id";
  assert.equal((await handler(idToken)).statusCode, 401);
  assert.equal(calls.length, 0);
});

test("only GET and OPTIONS exist; OPTIONS needs no auth", async () => {
  const { handler, calls } = setup();
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) assert.equal((await handler(proxy(method))).statusCode, 404);
  const options = await handler(proxy("OPTIONS", path, null));
  assert.equal(options.statusCode, 204);
  assert.equal(options.body, "");
  assert.equal(calls.length, 0);
});

test("route metadata must match exactly", async () => {
  const { handler, calls } = setup();
  for (const bad of [`/events/${id}/dashboard/`, `/events//dashboard`, `/events/${id}/dashboards`, `/events/${id}/dashboard/x`]) {
    assert.equal((await handler(proxy("GET", bad))).statusCode, 404, bad);
  }
  const wrongResource = proxy(); wrongResource.resource = "/events/{eventId}";
  assert.equal((await handler(wrongResource)).statusCode, 404);
  const wrongParameter = proxy(); wrongParameter.pathParameters = { eventId: "1" };
  assert.equal((await handler(wrongParameter)).statusCode, 404);
  const extraParameter = proxy(); extraParameter.pathParameters = { eventId: id, memberId: "2" };
  assert.equal((await handler(extraParameter)).statusCode, 404);
  const missingParameter = proxy(); missingParameter.pathParameters = { id };
  assert.equal((await handler(missingParameter)).statusCode, 404);
  assert.equal(calls.length, 0);
});

test("the production dashboard route fails closed without RDS secret mode", async (t) => {
  t.mock.method(console, "error", () => {});
  const aws = { ...env, DB_SECRET_ARN: "arn:test", DB_HOST: "rds.example", DB_NAME: "eventwise" };
  for (const bad of [{ DB_SECRET_ARN: "" }, { DB_HOST: "" }, { DYNAMODB_ENDPOINT: "http://localhost:8000" }]) {
    const handler = createEventsHandler({ env: { ...aws, ...bad } });
    const result = await handler(proxy());
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), { error: "Internal server error" });
  }
});
