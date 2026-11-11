import * as auth from "aws-amplify/auth";
import { authConfigurationError } from "../../../config/amplify";

export type { SignInOutput } from "aws-amplify/auth";

function requireConfiguration() {
  if (authConfigurationError) throw new Error(authConfigurationError);
}

// Keep the Amplify v6 inputs/outputs at this boundary so callers can handle nextStep.
export async function signUp(input: Parameters<typeof auth.signUp>[0]) {
  requireConfiguration();
  return auth.signUp(input);
}
export async function confirmSignUp(input: Parameters<typeof auth.confirmSignUp>[0]) {
  requireConfiguration();
  return auth.confirmSignUp(input);
}
export async function resendSignUpCode(input: Parameters<typeof auth.resendSignUpCode>[0]) {
  requireConfiguration();
  return auth.resendSignUpCode(input);
}
export async function signIn(input: Parameters<typeof auth.signIn>[0]) {
  requireConfiguration();
  return auth.signIn(input);
}
export async function confirmSignIn(input: Parameters<typeof auth.confirmSignIn>[0]) {
  requireConfiguration();
  return auth.confirmSignIn(input);
}
export async function signOut() {
  requireConfiguration();
  return auth.signOut();
}
export async function getCurrentUser() {
  requireConfiguration();
  return auth.getCurrentUser();
}
export async function fetchAuthSession() {
  requireConfiguration();
  return auth.fetchAuthSession();
}
export async function resetPassword(input: Parameters<typeof auth.resetPassword>[0]) {
  requireConfiguration();
  return auth.resetPassword(input);
}
export async function confirmResetPassword(input: Parameters<typeof auth.confirmResetPassword>[0]) {
  requireConfiguration();
  return auth.confirmResetPassword(input);
}

// An identity alone is insufficient: require an unexpired user-pool access token.
// fetchAuthSession refreshes expired tokens when a refresh token is available.
export async function requireAuthSession() {
  const user = await getCurrentUser();
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken;
  if (!token || !token.payload.exp || token.payload.exp * 1000 <= Date.now()) {
    const error = new Error("Your session has expired. Please sign in again.");
    error.name = "SessionExpiredError";
    throw error;
  }
  return { user, session };
}

export function authErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const messages: Record<string, string> = {
    NotAuthorizedException: "Unable to sign in. Check your email and password, or reset your password.",
    UserNotFoundException: "Unable to sign in. Check your email and password, or create an account.",
    UsernameExistsException: "An account with this email already exists. Sign in or reset your password.",
    UserNotConfirmedException: "Verify your email before signing in. You can request a new code here.",
    CodeMismatchException: "That verification code is incorrect. Please try again.",
    ExpiredCodeException: "That code has expired. Request a new code and try again.",
    InvalidPasswordException: "Choose a stronger password that meets your account's password requirements.",
    PasswordHistoryPolicyViolationException: "Choose a password you have not used before.",
    LimitExceededException: "Too many attempts. Please wait a few minutes and try again.",
    TooManyRequestsException: "Too many requests. Please wait a few minutes and try again.",
    SessionExpiredError: "Your session has expired. Please sign in again.",
    InvalidParameterException: "Check the entered details and try again. Your account may require additional information.",
    CodeDeliveryFailureException: "We could not deliver the code. Please wait and request a new one.",
    InvalidStateException: "This sign-in attempt has expired. Return to sign in and try again.",
    NetworkError: "Unable to connect. Check your connection and try again.",
    UserAlreadyAuthenticatedException: "You are already signed in. Use the landing page to open your dashboard.",
  };
  if (messages[name]) return messages[name];
  if (authConfigurationError) return authConfigurationError;
  return "We could not complete that request. Please try again. If it continues, contact your organizer administrator.";
}
