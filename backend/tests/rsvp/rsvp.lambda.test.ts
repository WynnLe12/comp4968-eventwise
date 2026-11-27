// RSVP API Lambda routing, auth and email rendering (no AWS needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import { createEmailSenderHandler } from "../../rsvp-service/lambda/emailSender";
import { createRsvpHandler, type RsvpProxyEvent } from "../../rsvp-service/lambda/rsvp";
import { parseEmailMessage, renderEmail } from "../../rsvp-service/notifications/emailContent";
import type { RsvpEmailMessage } from "../../rsvp-service/notifications/messages";
import { createEventAccess } from "../../rsvp-service/services/eventAccess";
import type { RsvpService } from "../../rsvp-service/services/rsvpService";

const POOL = "us-west-2_AbCdEf123";
const CLIENT = "client-123";
const ENV = { COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT, RSVP_CORS_ORIGIN: "http://localhost:5173" };
const CLAIMS = { token_use: "access", client_id: CLIENT, iss: `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`, sub: "user-1" };

type Calls = { name: string; args: unknown[] }[];

function fakeService(calls: Calls): Pick<RsvpService, "getSettings" | "sendInvitations" | "guestLink" | "getForGuest" | "respond"> {
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    if (name === "respond" && (args[1] as { attending?: unknown }).attending === "boom") {
      throw new ApiError(409, "RSVP_CLOSED", "RSVPs for this event have closed.");
    }
    return { ok: name } as never;
  };
  return {
    getSettings: record("getSettings"),
    sendInvitations: record("sendInvitations"),
    guestLink: record("guestLink"),
    getForGuest: record("getForGuest"),
    respond: record("respond"),
  };
}

function event(overrides: Partial<RsvpProxyEvent>): RsvpProxyEvent {
  return { httpMethod: "GET", resource: "/events/{eventId}/rsvp", pathParameters: { eventId: "42" }, ...overrides };
}

test("preflight, unknown routes and wrong methods are answered without the service", async () => {
  const calls: Calls = [];
  const handler = createRsvpHandler(ENV, fakeService(calls));
  const preflight = await handler(event({ httpMethod: "OPTIONS", resource: "/rsvp/{token}" }));
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], "http://localhost:5173");
  assert.equal((await handler(event({ resource: "/events/{eventId}/vendors" }))).statusCode, 404);
  const wrong = await handler(event({ httpMethod: "DELETE", resource: "/rsvp/{token}" }));
  assert.equal(wrong.statusCode, 405);
  assert.equal(wrong.headers.Allow, "GET, PUT, OPTIONS");
  assert.equal(calls.length, 0);
});

test("organizer routes need verified Cognito access-token claims and forward the Authorization header", async () => {
  const calls: Calls = [];
  const handler = createRsvpHandler(ENV, fakeService(calls));
  const denied = await handler(event({}));
  assert.equal(denied.statusCode, 401);
  const idToken = await handler(event({ requestContext: { authorizer: { claims: { ...CLAIMS, token_use: "id" } } } }));
  assert.equal(idToken.statusCode, 401);
  assert.equal(calls.length, 0);

  const ok = await handler(event({
    headers: { authorization: "Bearer abc" },
    requestContext: { authorizer: { claims: CLAIMS } },
  }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls[0], { name: "getSettings", args: ["42", "Bearer abc"] });

  await handler(event({
    httpMethod: "POST", resource: "/events/{eventId}/rsvp/invitations",
    headers: { Authorization: "Bearer abc", "Content-Type": "application/json" },
    body: JSON.stringify({ deadline: "2026-12-01T00:00:00Z" }),
    requestContext: { authorizer: { claims: CLAIMS } },
  }));
  assert.deepEqual(calls[1], { name: "sendInvitations", args: ["42", "user-1", "Bearer abc", { deadline: "2026-12-01T00:00:00Z" }] });
});

test("public RSVP routes need no sign-in, but writes must be JSON", async () => {
  const calls: Calls = [];
  const handler = createRsvpHandler(ENV, fakeService(calls));
  const read = await handler(event({ resource: "/rsvp/{token}", pathParameters: { token: "t" } }));
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["Referrer-Policy"], "no-referrer");

  const notJson = await handler(event({ httpMethod: "PUT", resource: "/rsvp/{token}", pathParameters: { token: "t" }, body: "attending=yes" }));
  assert.equal(notJson.statusCode, 415);

  const closed = await handler(event({
    httpMethod: "PUT", resource: "/rsvp/{token}", pathParameters: { token: "t" },
    headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ attending: "boom" }),
  }));
  assert.equal(closed.statusCode, 409);
  assert.equal(JSON.parse(closed.body).error.code, "RSVP_CLOSED");
});

test("the Event API check maps its answers to the RSVP API's errors", async () => {
  const reply = (status: number, body: unknown = {}) => async () => ({ status, ok: status < 300, json: async () => body });
  const url = "https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod";
  const ok = createEventAccess(url, reply(200, { event_id: "42", name: "Party", event_date: "2026-12-05", venue: null }));
  assert.deepEqual(await ok("42", "Bearer t"), { eventName: "Party", eventDate: "2026-12-05", venue: null });
  await assert.rejects(createEventAccess(url, reply(404))("42", "Bearer t"), (e: ApiError) => e.status === 403);
  await assert.rejects(createEventAccess(url, reply(401))("42", "Bearer t"), (e: ApiError) => e.status === 401);
  await assert.rejects(createEventAccess(url, reply(500))("42", "Bearer t"), (e: ApiError) => e.status === 502);
  await assert.rejects(ok("42", undefined), (e: ApiError) => e.status === 401);
  await assert.rejects(createEventAccess(undefined)("42", "Bearer t"), /EVENT_API_URL/);
});

// --- Emails -------------------------------------------------------------------------

const MESSAGE: RsvpEmailMessage = {
  type: "RSVP_INVITATION",
  to: "sofia@example.com",
  guestName: "Sofia",
  eventName: "Maya & Eli's <Wedding>",
  eventDate: "2026-12-05",
  startTime: "16:00",
  venue: "The Willow House",
  // The evening of Nov 30 in Vancouver under either UTC-8 or permanent UTC-7.
  deadline: "2026-12-01T06:30:00Z",
  message: "Dress code: garden party",
  rsvpUrl: "https://main.example.amplifyapp.com/rsvp/42.g1.sig",
};

test("emails show the date, start time, venue and Vancouver deadline, and escape HTML", () => {
  const email = renderEmail(MESSAGE);
  assert.equal(email.subject, "You're invited: Maya & Eli's <Wedding>");
  assert.match(email.text, /When: Saturday, December 5, 2026 at 4:00 PM/);
  assert.match(email.text, /Where: The Willow House/);
  assert.match(email.text, /Please reply by: Monday, November 30 at 1[01]:30 PM \(Vancouver time\)/);
  assert.match(email.text, /RSVP here: https:\/\/main\.example\.amplifyapp\.com\/rsvp\/42\.g1\.sig/);
  assert.equal(email.html.includes("<Wedding>"), false);
  assert.ok(email.html.includes("&lt;Wedding&gt;"));
  assert.match(renderEmail({ ...MESSAGE, type: "RSVP_REMINDER" }).subject, /^Reminder: please RSVP by Monday, November 30/);
});

test("queue messages that don't match the contract are rejected, and the sender fails only those", async () => {
  assert.ok(parseEmailMessage(JSON.stringify(MESSAGE)));
  assert.equal(parseEmailMessage(JSON.stringify({ ...MESSAGE, rsvpUrl: "https://evil.example/phish" })), null);
  assert.equal(parseEmailMessage(JSON.stringify({ ...MESSAGE, to: "not-an-email" })), null);
  assert.equal(parseEmailMessage("not json"), null);

  const sent: string[] = [];
  const handler = createEmailSenderHandler(async ({ to }) => { sent.push(to); }, { SES_FROM_ADDRESS: "hosts@example.com" }, () => {});
  const result = await handler({ Records: [
    { messageId: "ok", body: JSON.stringify(MESSAGE) },
    { messageId: "bad", body: "{}" },
  ] });
  assert.deepEqual(sent, ["sofia@example.com"]);
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "bad" }] });
});
