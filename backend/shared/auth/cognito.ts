import { CognitoJwtVerifier } from "aws-jwt-verify";
import { ApiError } from "../../expense-service/errors";

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
      verifier ??= CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
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
