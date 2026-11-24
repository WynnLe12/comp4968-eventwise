// Reads a signed-in organizer's verified email from their Cognito ID token (Feature 13).
//
// The timeline Lambda runs in the VPC without a NAT gateway, so it cannot call Cognito.
// Instead it verifies the ID token offline against the pool's public signing keys bundled
// in certs/cognito-jwks.json (refresh with scripts/refresh-cognito-jwks.ps1 if Cognito
// ever rotates them). Tokens signed with a key that is not in the file are rejected
// immediately, so the verifier never tries to download keys over the network.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { ApiError } from "../../expense-service/errors";
import { TimelineConfigurationError } from "../errors";

export type VerifyIdTokenEmail = (idToken: string, expectedSub: string) => Promise<string>;

export interface Jwks {
  keys: { kid: string; kty: string; alg?: string; use?: string; n?: string; e?: string }[];
}

export interface IdTokenEmailOptions {
  userPoolId?: string;
  clientId?: string;
  /** Inject keys in tests; otherwise read from COGNITO_JWKS_FILE or the bundled certs file. */
  jwks?: Jwks;
  jwksFile?: string;
}

/** certs/ sits two levels up from this file both in dist/ and in the Lambda package. */
export const DEFAULT_JWKS_FILE = join(__dirname, "..", "..", "certs", "cognito-jwks.json");

const invalidToken = () =>
  new ApiError(401, "UNAUTHENTICATED", "Your sign-in has expired. Sign in again to turn on timeline emails.");
const unverifiedEmail = () =>
  new ApiError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before turning on timeline emails.");

export function createIdTokenEmailVerifier(options: IdTokenEmailOptions = {}): VerifyIdTokenEmail {
  let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
  let knownKeyIds: Set<string> | undefined;

  function setUp() {
    const { userPoolId, clientId } = options;
    if (!userPoolId || !clientId) {
      throw new TimelineConfigurationError("COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required for timeline emails");
    }
    let jwks = options.jwks;
    if (!jwks) {
      try {
        jwks = JSON.parse(readFileSync(options.jwksFile || DEFAULT_JWKS_FILE, "utf8")) as Jwks;
      } catch {
        throw new TimelineConfigurationError("certs/cognito-jwks.json (or COGNITO_JWKS_FILE) could not be read");
      }
    }
    if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0) {
      throw new TimelineConfigurationError("certs/cognito-jwks.json has no signing keys");
    }
    const created = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "id" });
    created.cacheJwks(jwks as never);
    verifier = created;
    knownKeyIds = new Set(jwks.keys.map((key) => key.kid));
  }

  return async (idToken, expectedSub) => {
    if (!verifier) setUp();
    // Reject unknown signing keys before verify(): an unknown kid would make the
    // library fetch the pool's JWKS, which hangs without internet access.
    if (!knownKeyIds!.has(keyId(idToken) ?? "")) throw invalidToken();

    let payload: Record<string, unknown>;
    try {
      // Checks signature, issuer (this pool), audience (this app client), token_use=id and expiry.
      payload = (await verifier!.verify(idToken)) as Record<string, unknown>;
    } catch {
      throw invalidToken();
    }
    // The ID token must belong to the same person as the access token on the request.
    if (payload.sub !== expectedSub) throw invalidToken();
    if (payload.email_verified !== true && payload.email_verified !== "true") throw unverifiedEmail();
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email) || email.length > 254) throw unverifiedEmail();
    return email;
  };
}

function keyId(token: string): string | undefined {
  const [header] = token.split(".");
  try {
    const parsed = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")) as { kid?: unknown };
    return typeof parsed.kid === "string" ? parsed.kid : undefined;
  } catch {
    return undefined;
  }
}
