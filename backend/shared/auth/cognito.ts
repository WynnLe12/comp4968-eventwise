import { CognitoJwtVerifier } from "aws-jwt-verify";
import { ApiError } from "../../expense-service/errors";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Authenticate = (authorization: string | undefined) => Promise<string>;
// Configuration is lazy so /health and isolated tests require no Cognito setup.
export function createCognitoAuthenticator(env: NodeJS.ProcessEnv = process.env): Authenticate {
  let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
  return async authorization => {
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) throw new ApiError(401, "UNAUTHENTICATED", "A valid bearer access token is required.");
    const userPoolId = env.COGNITO_USER_POOL_ID;
    const clientId = env.COGNITO_CLIENT_ID;
    if (!userPoolId || !clientId) throw new ApiError(503, "SERVICE_UNAVAILABLE", "Authentication is not configured.");
    try {
      if (!verifier) {
        verifier = CognitoJwtVerifier.create({
          userPoolId,
          clientId,
          tokenUse: "access",
        });

        const jwksFile = env.COGNITO_JWKS_FILE?.trim();

        if (jwksFile) {
          const jwksPath = resolve(jwksFile);

          const jwks = JSON.parse(
            readFileSync(jwksPath, "utf8")
          );

          verifier.cacheJwks(jwks, userPoolId);
        }
      }
    } catch {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Authentication is not configured correctly.");
    }
    try {
      const payload = await verifier.verify(match[1]!);
      return payload.sub;
    } catch {
      throw new ApiError(401, "UNAUTHENTICATED", "A valid bearer access token is required.");
    }
  };
}
