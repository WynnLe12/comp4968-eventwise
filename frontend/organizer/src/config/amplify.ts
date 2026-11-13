import { Amplify } from "aws-amplify";

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID?.trim();
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID?.trim();
const region = import.meta.env.VITE_AWS_REGION?.trim();

// Amplify v6 derives the Cognito region from the pool ID.
export const authConfigurationError =
  !userPoolId || !userPoolClientId || !region
    ? "Sign-in is unavailable. Configure the Cognito pool, client ID, and AWS region."
    : !userPoolId.startsWith(`${region}_`)
      ? "Sign-in is unavailable. The Cognito pool and AWS region must match."
      : "";

if (!authConfigurationError) {
  Amplify.configure({
    Auth: { Cognito: { userPoolId, userPoolClientId } },
  });
}
