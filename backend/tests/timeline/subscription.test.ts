// Organizer timeline-email subscriptions: offline ID-token verification with real RS256
// signatures, the subscription service and the Lambda route (no AWS, Docker or MySQL).

import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { test } from "node:test";
import type { ApiError } from "../../expense-service/errors";
import { SUBSCRIPTION_RESOURCE, createTimelineHandler } from "../../timeline-service/lambda/timeline";
import { TimelineConfigurationError } from "../../timeline-service/services/guestTimelineService";
import { createIdTokenEmailVerifier, type Jwks } from "../../timeline-service/services/idTokenEmail";
import { GuestTimelineService } from "../../timeline-service/services/guestTimelineService";
import { SubscriptionService } from "../../timeline-service/services/subscriptionService";
import { TimelineService } from "../../timeline-service/services/timelineService";
import { MemoryTimelineStore, memberships } from "./fakes";

const POOL = "us-west-2_testpool";
const CLIENT = "testclient";
const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: "jwk" }) as object), kid, alg: "RS256", use: "sig" } };
}

const signing = keyPair("key-1");
const stranger = keyPair("key-unknown");
const JWKS = { keys: [signing.jwk] } as Jwks;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(claims: Record<string, unknown>, key: { kid: string; privateKey: KeyObject } = signing) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "RS256", kid: key.kid, typ: "JWT" });
  const payload = b64({
    sub: "sub-owner", aud: CLIENT, iss: ISSUER, token_use: "id", email: "Maya@Example.com",
    email_verified: true, iat: now, auth_time: now, exp: now + 3600, ...claims,
  });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const verify = createIdTokenEmailVerifier({ userPoolId: POOL, clientId: CLIENT, jwks: JWKS });

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: ApiError) => error.status === status && error.code === code);
}

// --- ID token verification ---------------------------------------------------------

test("a valid ID token for the same user gives their verified email, lowercased", async () => {
  assert.equal(await verify(jwt({}), "sub-owner"), "maya@example.com");
  assert.equal(await verify(jwt({ email_verified: "true" }), "sub-owner"), "maya@example.com");
});

test("forged, foreign, expired and access tokens are 401", async () => {
  const cases: [string, string][] = [
    ["unknown signing key", jwt({}, stranger)],
    ["signed by another key under a known kid", jwt({}, { kid: "key-1", privateKey: stranger.privateKey })],
    ["other user pool", jwt({ iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_other" })],
    ["other app client", jwt({ aud: "other-client" })],
    ["access token", jwt({ token_use: "access" })],
    ["expired", jwt({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["tampered payload", jwt({}).replace(/\.[^.]+\./, `.${b64({ sub: "sub-owner", email: "evil@x.com" })}.`)],
    ["garbage", "aaa.bbb.ccc"],
  ];
  for (const [name, token] of cases) {
    await assert.rejects(verify(token, "sub-owner"), (e: ApiError) => e.status === 401, name);
  }
});

test("another user's ID token is 401, even when valid", async () => {
  await rejectsWith(verify(jwt({ sub: "sub-planner" }), "sub-owner"), 401, "UNAUTHENTICATED");
});

test("an unverified or missing email is 403 EMAIL_NOT_VERIFIED", async () => {
  await rejectsWith(verify(jwt({ email_verified: false }), "sub-owner"), 403, "EMAIL_NOT_VERIFIED");
  await rejectsWith(verify(jwt({ email: undefined }), "sub-owner"), 403, "EMAIL_NOT_VERIFIED");
  await rejectsWith(verify(jwt({ email: "not an email" }), "sub-owner"), 403, "EMAIL_NOT_VERIFIED");
});

test("missing Cognito settings or keys are a configuration error naming the setting", async () => {
  await assert.rejects(createIdTokenEmailVerifier({ clientId: CLIENT, jwks: JWKS })(jwt({}), "sub-owner"),
    (e: Error) => e instanceof TimelineConfigurationError && /COGNITO_USER_POOL_ID/.test(e.message));
  await assert.rejects(createIdTokenEmailVerifier({ userPoolId: POOL, clientId: CLIENT, jwksFile: "/nope.json" })(jwt({}), "s"),
    (e: Error) => e instanceof TimelineConfigurationError && /cognito-jwks/.test(e.message));
  await assert.rejects(createIdTokenEmailVerifier({ userPoolId: POOL, clientId: CLIENT, jwks: { keys: [] } })(jwt({}), "s"),
    TimelineConfigurationError);
});

test("the bundled keys file loads and the unknown-key check runs before any network fetch", async () => {
  const bundled = createIdTokenEmailVerifier({ userPoolId: POOL, clientId: CLIENT, jwksFile: `${__dirname}/../../../certs/cognito-jwks.json` });
  const started = Date.now();
  await rejectsWith(bundled(jwt({}), "sub-owner"), 401, "UNAUTHENTICATED");
  assert.ok(Date.now() - started < 1000, "an unknown key must fail fast, not try to download keys");
});

// --- Service ------------------------------------------------------------------------

function service() {
  const store = new MemoryTimelineStore();
  const subscriptions = new SubscriptionService({
    repository: store,
    verifyIdTokenEmail: verify,
    requireMember: memberships([["42", "sub-owner"], ["42", "sub-planner"]]).check,
  });
  return { store, subscriptions };
}

test("members can turn timeline emails on, check them and turn them off", async () => {
  const { store, subscriptions } = service();
  assert.deepEqual(await subscriptions.get("42", "sub-owner"), { subscribed: false, email: null });
  assert.deepEqual(await subscriptions.subscribe("42", "sub-owner", { idToken: jwt({}) }), { subscribed: true, email: "maya@example.com" });
  assert.deepEqual(await subscriptions.get("42", "sub-owner"), { subscribed: true, email: "maya@example.com" });
  assert.equal((await store.listSubscribers("42")).length, 1);
  await subscriptions.unsubscribe("42", "sub-owner");
  await subscriptions.unsubscribe("42", "sub-owner"); // idempotent
  assert.deepEqual(await subscriptions.get("42", "sub-owner"), { subscribed: false, email: null });
});

test("subscribing again refreshes the stored email", async () => {
  const { subscriptions } = service();
  await subscriptions.subscribe("42", "sub-owner", { idToken: jwt({}) });
  await subscriptions.subscribe("42", "sub-owner", { idToken: jwt({ email: "new@example.com" }) });
  assert.equal((await subscriptions.get("42", "sub-owner")).email, "new@example.com");
});

test("non-members get 403 before the token is looked at; a co-planner cannot subscribe with the owner's token", async () => {
  const { store, subscriptions } = service();
  await rejectsWith(subscriptions.subscribe("42", "sub-stranger", { idToken: "x" }), 403, "FORBIDDEN");
  await rejectsWith(subscriptions.get("42", "sub-stranger"), 403, "FORBIDDEN");
  await rejectsWith(subscriptions.subscribe("42", "sub-planner", { idToken: jwt({ sub: "sub-owner" }) }), 401, "UNAUTHENTICATED");
  await rejectsWith(subscriptions.subscribe("42", "sub-owner", { idToken: "x", email: "me@x.com" }), 422, "VALIDATION_ERROR");
  assert.equal(store.subscribers.size, 0);
});

// --- Lambda route -------------------------------------------------------------------

test("the subscription route supports GET, PUT and DELETE through the Lambda", async () => {
  const { store, subscriptions } = service();
  const env = { COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT } as NodeJS.ProcessEnv;
  const handler = createTimelineHandler(
    new TimelineService({ repository: store, requireMember: async () => "42" }),
    env,
    new GuestTimelineService({ repository: store, requireMember: async () => "42", events: async () => null }),
    subscriptions,
  );
  const call = (httpMethod: string, body?: unknown) => handler({
    httpMethod, resource: SUBSCRIPTION_RESOURCE, pathParameters: { eventId: "42" },
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : null,
    requestContext: { authorizer: { claims: { sub: "sub-owner", token_use: "access", client_id: CLIENT, iss: ISSUER } } },
  });

  const put = await call("PUT", { idToken: jwt({}) });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(JSON.parse(put.body), { subscribed: true, email: "maya@example.com" });
  assert.equal(JSON.parse((await call("GET")).body).subscribed, true);
  const removed = await call("DELETE");
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");
  assert.equal((await call("POST", {})).statusCode, 405);
  assert.equal(JSON.parse((await call("PUT", { idToken: jwt({ sub: "someone-else" }) })).body).error.code, "UNAUTHENTICATED");
});
