
import { CognitoJwtVerifier } from "aws-jwt-verify";

const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;

if (!userPoolId || !clientId) {
  throw new Error("Missing Cognito environment configuration");
}

const verifier = CognitoJwtVerifier.create({
  userPoolId,
  tokenUse: "access",
  clientId,
});

export async function verifyToken(token: string): Promise<string> {
  const payload = await verifier.verify(token);
  return payload.sub;
}
