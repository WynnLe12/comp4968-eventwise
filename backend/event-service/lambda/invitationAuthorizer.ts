import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  CognitoJwtInvalidClientIdError, CognitoJwtInvalidTokenUseError, FailedAssertionError,
  JwtExpiredError, JwtInvalidIssuerError, JwtInvalidSignatureAlgorithmError, JwtInvalidSignatureError,
  JwtNotBeforeError, JwtParseError, JwtWithoutValidKidError, KidNotFoundInJwksError,
  ParameterValidationError, WaitPeriodNotYetEndedJwkError,
} from "aws-jwt-verify/error";
import type { JwksCache } from "aws-jwt-verify/jwk";
import {
  createCognitoVerifiedEmailResolver, InvalidCognitoAccessTokenError,
  VerifiedEmailRequiredError, type ResolveVerifiedEmail,
} from "../../shared/auth/verifiedEmail";
import { invitationAcceptanceRoute, invitationAuthorizerVersion, invitationBearer, validInvitationSubject } from "../invitationAcceptanceAuth";
import { normalizeInvitationEmail } from "../invitationEmail";

interface TokenAuthorizerEvent {
  type?: unknown;
  authorizationToken?: unknown;
  methodArn?: unknown;
}

type ConfigurationField = "EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN" | "COGNITO_USER_POOL_ID" | "COGNITO_CLIENT_ID" |
  "EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE";

function invalidConfiguration(field: ConfigurationField, issue: "missing" | "invalid"): never {
  console.warn("Invitation authorization failed", { reason: "configuration", field, issue });
  throw new Error("Invitation authorizer configuration is invalid");
}

function logFailure(reason: string) {
  // Log only fixed reason codes. Verifier errors can carry JWT claims or key IDs.
  console.warn("Invitation authorization failed", { reason });
}

function unauthorized(reason: string): never {
  logFailure(reason);
  throw new Error("Unauthorized");
}

function jwtRejectionReason(error: unknown): string | undefined {
  if (error instanceof CognitoJwtInvalidClientIdError) return "jwt_client_id";
  if (error instanceof CognitoJwtInvalidTokenUseError) return "jwt_token_use";
  // The configured verifier throws ParameterValidationError for an unknown issuer.
  if (error instanceof JwtInvalidIssuerError || error instanceof ParameterValidationError) return "jwt_issuer";
  if (error instanceof JwtExpiredError) return "jwt_expired";
  if (error instanceof JwtNotBeforeError) return "jwt_not_yet_valid";
  if (error instanceof JwtInvalidSignatureError || error instanceof JwtInvalidSignatureAlgorithmError) return "jwt_signature";
  if (error instanceof JwtParseError) return "jwt_format";
  if (error instanceof JwtWithoutValidKidError || error instanceof KidNotFoundInJwksError ||
      error instanceof WaitPeriodNotYetEndedJwkError) return "jwt_signing_key";
  if (error instanceof FailedAssertionError) return "jwt_assertion";
  return undefined;
}

function accessPolicy(methodArn: string, principalId: string, effect: "Allow" | "Deny") {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: methodArn }],
    },
  };
}

export function createInvitationAuthorizer({
  env = process.env, jwksCache, resolveVerifiedEmail = createCognitoVerifiedEmailResolver(env),
}: {
  env?: NodeJS.ProcessEnv;
  jwksCache?: JwksCache;
  resolveVerifiedEmail?: ResolveVerifiedEmail;
} = {}) {
  const methodArn = env.EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN;
  const route = invitationAcceptanceRoute(methodArn);
  const userPoolId = env.COGNITO_USER_POOL_ID;
  const clientId = env.COGNITO_CLIENT_ID;
  const poolRegion = /^([a-z0-9-]+)_[A-Za-z0-9]+$/.exec(userPoolId ?? "")?.[1];
  const issuer = `https://cognito-idp.${poolRegion}.amazonaws.com/${userPoolId}`;
  let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

  return async (event: TokenAuthorizerEvent) => {
    if (!route) invalidConfiguration("EVENTS_INVITATION_ACCEPTANCE_METHOD_ARN", methodArn ? "invalid" : "missing");
    if (!poolRegion || !userPoolId) invalidConfiguration("COGNITO_USER_POOL_ID", userPoolId ? "invalid" : "missing");
    if (!clientId) invalidConfiguration("COGNITO_CLIENT_ID", "missing");
    const caseInsensitive = env.EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE;
    if (caseInsensitive !== "true") {
      invalidConfiguration("EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE", caseInsensitive ? "invalid" : "missing");
    }
    if (event?.type !== "TOKEN") unauthorized("event_type");
    if (event.methodArn !== route.arn) unauthorized("method_arn");
    const token = invitationBearer(event.authorizationToken);
    if (!token) unauthorized("authorization_header");

    let payload: Awaited<ReturnType<NonNullable<typeof verifier>["verify"]>>;
    verifier ??= CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" }, jwksCache ? { jwksCache } : undefined);
    try {
      payload = await verifier.verify(token);
    } catch (error) {
      const reason = jwtRejectionReason(error);
      if (reason) unauthorized(reason);
      logFailure("jwt_verification_unavailable");
      throw new Error("Invitation access token verification unavailable");
    }

    const { sub, exp, scope } = payload;
    if (payload.iss !== issuer) unauthorized("jwt_issuer");
    if (!validInvitationSubject(sub)) unauthorized("jwt_subject");
    if (!Number.isSafeInteger(exp) || exp * 1000 <= Date.now()) unauthorized("jwt_expiration");
    const deny = (reason: string) => {
      logFailure(reason);
      return accessPolicy(route.arn, sub, "Deny");
    };
    if (typeof scope !== "string" || !scope.split(" ").includes("aws.cognito.signin.user.admin")) return deny("jwt_scope");

    let email: string | undefined;
    try {
      email = normalizeInvitationEmail(await resolveVerifiedEmail(token, sub));
    } catch (error) {
      if (error instanceof InvalidCognitoAccessTokenError) unauthorized("get_user_token_rejected");
      if (error instanceof VerifiedEmailRequiredError) return deny("get_user_identity_unverified");
      logFailure("get_user_unavailable");
      throw new Error("Invitation email verification unavailable");
    }
    if (!email) return deny("get_user_email_invalid");

    return {
      ...accessPolicy(route.arn, sub, "Allow"),
      context: { invitationAuthVersion: invitationAuthorizerVersion, invitationSub: sub, invitationVerifiedEmail: email },
    };
  };
}

export const handler = createInvitationAuthorizer();
