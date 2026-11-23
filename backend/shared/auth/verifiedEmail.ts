import { CognitoIdentityProviderClient, GetUserCommand, type GetUserCommandOutput } from "@aws-sdk/client-cognito-identity-provider";
import { profileDisplayName } from "./profileDisplayName";

export class VerifiedEmailRequiredError extends Error {}
export class EmailVerificationUnavailableError extends Error {}
export class InvalidCognitoAccessTokenError extends Error {}

interface VerifiedProfile { email: string; displayName?: string }
export type ResolveVerifiedProfile = (accessToken: string, verifiedSub: string) => Promise<VerifiedProfile>;
export type ResolveCognitoDisplayName = (accessToken: string, verifiedSub: string) => Promise<string | undefined>;
type GetUser = (accessToken: string) => Promise<Pick<GetUserCommandOutput, "UserAttributes">>;

export function createVerifiedProfileResolver(getUser: GetUser): ResolveVerifiedProfile {
  return async (accessToken, verifiedSub) => {
    let result: Awaited<ReturnType<GetUser>>;
    try {
      result = await getUser(accessToken);
    } catch (error) {
      if (error instanceof Error && ["NotAuthorizedException", "UserNotFoundException"].includes(error.name)) {
        throw new InvalidCognitoAccessTokenError("Invalid or expired authentication token");
      }
      throw new EmailVerificationUnavailableError("Unable to verify your email right now. Please try again.");
    }
    const attributes = result.UserAttributes ?? [];
    const subject = attributes.filter(attribute => attribute.Name === "sub");
    const email = attributes.filter(attribute => attribute.Name === "email");
    const verified = attributes.filter(attribute => attribute.Name === "email_verified");
    if (subject.length !== 1 || subject[0].Value !== verifiedSub ||
        email.length !== 1 || !email[0].Value?.trim() ||
        verified.length !== 1 || verified[0].Value !== "true") {
      throw new VerifiedEmailRequiredError("A matching verified email is required");
    }
    return { email: email[0].Value, displayName: profileDisplayName(attributes) };
  };
}

export function createCognitoDisplayNameResolver(env: NodeJS.ProcessEnv, getUser = createGetUser(env, 1500)): ResolveCognitoDisplayName {
  return async (accessToken, verifiedSub) => {
    const attributes = (await getUser(accessToken)).UserAttributes ?? [];
    const subjects = attributes.filter(attribute => attribute.Name === "sub");
    return subjects.length === 1 && subjects[0].Value === verifiedSub ? profileDisplayName(attributes) : undefined;
  };
}

function createGetUser(env: NodeJS.ProcessEnv, timeoutMs: number): GetUser {
  let client: CognitoIdentityProviderClient | undefined;
  return async accessToken => {
    const region = /^([a-z0-9-]+)_[A-Za-z0-9]+$/.exec(env.COGNITO_USER_POOL_ID ?? "")?.[1];
    if (!region) throw new Error("Cognito profile lookup is not configured");
    client ??= new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
    return client.send(new GetUserCommand({ AccessToken: accessToken }), { abortSignal: AbortSignal.timeout(timeoutMs) });
  };
}

export function createCognitoVerifiedProfileResolver(env: NodeJS.ProcessEnv): ResolveVerifiedProfile {
  const getUser = createGetUser(env, 4000);
  return createVerifiedProfileResolver(async accessToken => {
    // F2.2 collapses case variants. Enable only for a pool where they cannot
    // represent different verified accounts.
    if (env.EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE !== "true") {
      throw new Error("Cognito invitation email verification is not configured");
    }
    return getUser(accessToken);
  });
}
