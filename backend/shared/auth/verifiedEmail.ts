import { CognitoIdentityProviderClient, GetUserCommand, type GetUserCommandOutput } from "@aws-sdk/client-cognito-identity-provider";

export class VerifiedEmailRequiredError extends Error {}
export class EmailVerificationUnavailableError extends Error {}
export class InvalidCognitoAccessTokenError extends Error {}

export type ResolveVerifiedEmail = (accessToken: string, verifiedSub: string) => Promise<string>;
type GetUser = (accessToken: string) => Promise<Pick<GetUserCommandOutput, "UserAttributes">>;

export function createVerifiedEmailResolver(getUser: GetUser): ResolveVerifiedEmail {
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
    return email[0].Value;
  };
}

export function createCognitoVerifiedEmailResolver(env: NodeJS.ProcessEnv): ResolveVerifiedEmail {
  let client: CognitoIdentityProviderClient | undefined;
  return createVerifiedEmailResolver(async accessToken => {
    const region = /^([a-z0-9-]+)_[A-Za-z0-9]+$/.exec(env.COGNITO_USER_POOL_ID ?? "")?.[1];
    // F2.2 collapses case variants. Enable only for a pool where they cannot
    // represent different verified accounts.
    if (!region || env.EVENTS_INVITATION_EMAIL_CASE_INSENSITIVE !== "true") {
      throw new Error("Cognito invitation email verification is not configured");
    }
    client ??= new CognitoIdentityProviderClient({ region, maxAttempts: 1 });
    return client.send(new GetUserCommand({ AccessToken: accessToken }), { abortSignal: AbortSignal.timeout(4_000) });
  });
}
