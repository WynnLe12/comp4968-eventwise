import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test, type TestContext } from "node:test";
import { FetchError } from "aws-jwt-verify/error";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import { createInvitationAuthorizer } from "../event-service/lambda/invitationAuthorizer";
import { createVerifiedEmailResolver } from "../shared/auth/verifiedEmail";

const methodArn = "arn:aws:execute-api:us-west-2:123456789012:hd63bpgxm8/prod/POST/event-invitations/accept";
const env = {
  EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN: methodArn,
  EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE: "true",
  COGNITO_USER_POOL_ID: "us-west-2_testpool",
  COGNITO_CLIENT_ID: "testclient",
};
const issuer = `https://cognito-idp.us-west-2.amazonaws.com/${env.COGNITO_USER_POOL_ID}`;
const alternateIssuer = issuer.replace("https://cognito-idp.", "https://issuer-cognito-idp.");
const sub = "verified-cognito-sub";
const requiredScope = "aws.cognito.signin.user.admin";
const attributes = [
  { Name: "sub", Value: sub }, { Name: "email", Value: " Planner@Example.com " }, { Name: "email_verified", Value: "true" },
];
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const key = { ...publicKey.export({ format: "jwk" }), kty: "RSA", kid: "cognito-test-key", alg: "RS256", use: "sig" };

function jwt(overrides: Record<string, unknown> = {}, signer = privateKey, kid = key.kid) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "RS256", kid })}.${encode({
    iss: issuer, client_id: env.COGNITO_CLIENT_ID, sub, token_use: "access", scope: `other ${requiredScope}`,
    exp: Math.floor(Date.now() / 1000) + 60, ...overrides,
  })}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), signer).toString("base64url")}`;
}

function event(token: string) {
  return { type: "TOKEN", authorizationToken: `Bearer ${token}`, methodArn };
}

function fixture(getUser: Parameters<typeof createVerifiedEmailResolver>[0] = async () => ({ UserAttributes: attributes })) {
  const jwksCache = new SimpleJwksCache({ fetcher: { async fetch() { assert.fail("Unexpected JWKS fetch"); } } });
  for (const origin of [issuer, alternateIssuer]) jwksCache.addJwks(`${origin}/.well-known/jwks.json`, { keys: [key] });
  const calls: string[] = [];
  const resolveVerifiedEmail = createVerifiedEmailResolver(async token => {
    calls.push(token);
    return getUser(token);
  });
  return { calls, handler: createInvitationAuthorizer({ env, jwksCache, resolveVerifiedEmail }) };
}

function expectFailures(t: TestContext) {
  const logs = t.mock.method(console, "warn", () => {});
  return (...reasons: string[]) => assert.deepEqual(logs.mock.calls.map(call => call.arguments),
    reasons.map(reason => ["Invitation authorization failed", { reason }]));
}

test("authorizer verifies a signed access token, calls GetUser on every request and allows only the exact acceptance ARN", async t => {
  const assertFailures = expectFailures(t);
  const token = jwt();
  const { handler, calls } = fixture();
  const expected = {
    principalId: sub,
    policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: methodArn }] },
    context: { invitationAuthVersion: "1", invitationSub: sub, invitationVerifiedEmail: "planner@example.com" },
  };
  assert.deepEqual(await handler(event(token)), expected);
  assert.deepEqual(await handler(event(token)), expected);
  assert.deepEqual(calls, [token, token]);
  assertFailures();
});

test("authorizer rejects malformed requests, wrong ARN and invalid JWTs before GetUser and logs only reason codes", async t => {
  const assertFailures = expectFailures(t);
  const { handler, calls } = fixture();
  const cases = [
    [event("malformed"), "jwt_format"],
    [event(jwt({}, wrongKey)), "jwt_signature"],
    [event(jwt({ iss: `${issuer}other` })), "jwt_issuer"],
    [event(jwt({ iss: alternateIssuer })), "jwt_issuer"],
    [event(jwt({ exp: 1 })), "jwt_expired"],
    [event(jwt({ exp: undefined })), "jwt_expiration"],
    [event(jwt({ nbf: Math.floor(Date.now() / 1000) + 30 })), "jwt_not_yet_valid"],
    [event(jwt({ token_use: "id", aud: env.COGNITO_CLIENT_ID })), "jwt_token_use"],
    [event(jwt({ client_id: "other-app" })), "jwt_client_id"],
    [event(jwt({ sub: "" })), "jwt_subject"],
    [event(jwt({ sub: undefined })), "jwt_subject"],
    [{ ...event(jwt()), type: "REQUEST" }, "event_type"],
    [{ ...event(jwt()), authorizationToken: jwt() }, "authorization_header"],
    [event(`${jwt()}, Bearer ${jwt()}`), "authorization_header"],
    ...[methodArn.replace("hd63bpgxm8", "different"), methodArn.replace("123456789012", "999999999999"),
      methodArn.replace("us-west-2", "us-east-1"), methodArn.replace("/prod/", "/dev/"),
      methodArn.replace("/POST/", "/GET/"), `${methodArn}/`].map(otherArn => [{ ...event(jwt()), methodArn: otherArn }, "method_arn"] as const),
  ] as const;
  for (const [input] of cases) {
    await assert.rejects(handler(input), { message: "Unauthorized" });
  }
  assert.deepEqual(calls, []);
  assertFailures(...cases.map(([, reason]) => reason));
});

test("authorizer reports an unknown signing key without logging the key ID", async t => {
  const assertFailures = expectFailures(t);
  const jwksCache = new SimpleJwksCache({ fetcher: {
    async fetch() { return new TextEncoder().encode(JSON.stringify({ keys: [key] })).buffer; },
  } });
  const handler = createInvitationAuthorizer({ env, jwksCache, async resolveVerifiedEmail() { assert.fail("Unexpected GetUser"); } });
  await assert.rejects(handler(event(jwt({}, privateKey, "untrusted-key-id"))), { message: "Unauthorized" });
  assertFailures("jwt_signing_key");
});

test("authorizer denies wrong scope without calling GetUser", async t => {
  const assertFailures = expectFailures(t);
  const { handler, calls } = fixture();
  for (const scope of [undefined, "other", `${requiredScope}.extra`]) {
    const result = await handler(event(jwt({ scope })));
    assert.equal(result.policyDocument.Statement[0].Effect, "Deny");
    assert.ok(!("context" in result));
  }
  assert.deepEqual(calls, []);
  assertFailures("jwt_scope", "jwt_scope", "jwt_scope");
});

test("authorizer denies mismatched subjects and missing, ambiguous or unverified email", async t => {
  const assertFailures = expectFailures(t);
  const invalidAttributes = [undefined, attributes.slice(1), attributes.filter(value => value.Name !== "email"),
    [...attributes, attributes[0]], [...attributes, attributes[1]], [...attributes, attributes[2]],
    [...attributes.slice(0, 2), { Name: "email_verified", Value: "false" }],
    [...attributes.slice(0, 2), { Name: "email_verified", Value: "TRUE" }],
    [{ Name: "sub", Value: "different-account" }, ...attributes.slice(1)]];
  for (const UserAttributes of invalidAttributes) {
    const { handler, calls } = fixture(async () => ({ UserAttributes }));
    const token = jwt();
    const result = await handler(event(token));
    assert.equal(result.policyDocument.Statement[0].Effect, "Deny");
    assert.ok(!("context" in result));
    assert.deepEqual(calls, [token]);
  }
  assertFailures(...invalidAttributes.map(() => "get_user_identity_unverified"));
});

test("authorizer fails closed on revoked tokens and upstream errors", async t => {
  const assertFailures = expectFailures(t);
  const token = jwt();
  for (const [name, message] of [
    ["NotAuthorizedException", "Unauthorized"], ["UserNotFoundException", "Unauthorized"],
    ["TooManyRequestsException", "Invitation email verification unavailable"], ["AbortError", "Invitation email verification unavailable"],
  ]) {
    const { handler } = fixture(async () => { throw Object.assign(new Error(`private ${token} ${attributes[1].Value}`), { name }); });
    await assert.rejects(handler(event(token)), { message });
  }
  const jwksCache = new SimpleJwksCache({ fetcher: { async fetch() { throw new FetchError(issuer, "unavailable"); } } });
  const unavailableJwks = createInvitationAuthorizer({ env, jwksCache });
  await assert.rejects(unavailableJwks(event(token)), { message: "Invitation access token verification unavailable" });
  assertFailures("get_user_token_rejected", "get_user_token_rejected", "get_user_unavailable", "get_user_unavailable",
    "jwt_verification_unavailable");
});

test("authorizer reports the failing configuration field without logging any supplied values", async t => {
  const logs = t.mock.method(console, "warn", () => {});
  const cases = [
    ["EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN", undefined, "missing"],
    ["EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN", methodArn.replace("123456789012", "<account-id>"), "invalid"],
    ["EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN", methodArn.replace("/prod/POST/event-invitations/accept", "/authorizers/example"), "invalid"],
    ["EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN", `${methodArn} `, "invalid"],
    ["COGNITO_USER_POOL_ID", undefined, "missing"],
    ["COGNITO_USER_POOL_ID", env.COGNITO_USER_POOL_ID.toUpperCase(), "invalid"],
    ["COGNITO_USER_POOL_ID", issuer, "invalid"],
    ["COGNITO_CLIENT_ID", "", "missing"],
    ["EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE", undefined, "missing"],
    ["EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE", "True", "invalid"],
    ["EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE", "true ", "invalid"],
  ] as const;
  for (const [field, value] of cases) {
    const handler = createInvitationAuthorizer({
      env: { ...env, [field]: value },
      jwksCache: new SimpleJwksCache({ fetcher: { async fetch() { assert.fail("Unexpected JWKS fetch"); } } }),
      async resolveVerifiedEmail() { assert.fail("Unexpected GetUser"); },
    });
    await assert.rejects(handler(event(jwt())), { message: "Invitation authorizer configuration is invalid" });
  }
  assert.deepEqual(logs.mock.calls.map(call => call.arguments), cases.map(([field, , issue]) =>
    ["Invitation authorization failed", { reason: "configuration", field, issue }]));
});
