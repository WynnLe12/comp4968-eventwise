import { useRef, useState, type FormEvent } from "react";
import { Brand } from "../../../components/layout";
import { Button, Card, Field, Icon } from "../../../components/ui";
import type { PublicPage } from "../../../types";
import {
  authErrorMessage, confirmResetPassword, confirmSignIn, confirmSignUp,
  requireAuthSession, resendSignUpCode, resetPassword, signIn, signUp,
  type SignInOutput,
} from "../services/authService";

const authCopy: Record<Exclude<PublicPage, "landing">, [string, string]> = {
  login: ["Welcome back", "Sign in to continue planning the good stuff."],
  signup: ["Let?s plan something wonderful", "Create your free EventWise account."],
  reset: ["Reset your password", "We?ll send a verification code to your inbox."],
};

type Step = "form" | "verify" | "reset-code" | "challenge" | "verified";
type NextStep = SignInOutput["nextStep"];
const challengeLabels: Partial<Record<NextStep["signInStep"], string>> = {
  CONFIRM_SIGN_IN_WITH_SMS_CODE: "SMS verification code",
  CONFIRM_SIGN_IN_WITH_EMAIL_CODE: "Email verification code",
  CONFIRM_SIGN_IN_WITH_TOTP_CODE: "Authenticator code",
  CONTINUE_SIGN_IN_WITH_TOTP_SETUP: "Authenticator code",
  CONTINUE_SIGN_IN_WITH_EMAIL_SETUP: "Email address for verification",
  CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED: "New password",
  CONFIRM_SIGN_IN_WITH_PASSWORD: "Password",
  CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE: "Challenge response",
  CONTINUE_SIGN_IN_WITH_MFA_SELECTION: "Verification method",
  CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION: "Verification method to set up",
  CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION: "Sign-in method",
};

export function AuthCard({ page, setPage, enterApp }: {
  page: Exclude<PublicPage, "landing">;
  setPage: (p: PublicPage) => void;
  enterApp: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [challenge, setChallenge] = useState<NextStep | null>(null);
  const [response, setResponse] = useState("");
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const username = email.trim();
  const [title, subtitle] = step === "verify"
    ? ["Verify your email", "Enter the verification code sent to your inbox."]
    : step === "reset-code"
      ? ["Choose a new password", "Enter the emailed verification code and your new password."]
      : step === "challenge"
        ? ["Complete sign in", "Your account requires another verification step."]
        : step === "verified"
          ? ["Email verified", "Your account is ready. Sign in to continue."]
          : authCopy[page];

  async function startReset() {
    const result = await resetPassword({ username });
    setPassword("");
    if (result.nextStep.resetPasswordStep === "CONFIRM_RESET_PASSWORD_WITH_CODE") {
      setStep("reset-code");
      setCode("");
      setMessage(`Check your email${result.nextStep.codeDeliveryDetails.destination ? ` at ${result.nextStep.codeDeliveryDetails.destination}` : ""} for a reset code.`);
    } else {
      setStep("form");
      setPage("login");
      setMessage("Password reset completed. Please sign in.");
    }
  }

  async function handleSignInResult(result: SignInOutput) {
    setPassword("");
    setResponse("");
    setAttributes({});
    if (result.isSignedIn && result.nextStep.signInStep === "DONE") {
      await requireAuthSession();
      await enterApp();
    } else if (result.nextStep.signInStep === "CONFIRM_SIGN_UP") {
      setStep("verify");
      setMessage("Verify your email to continue. Enter your code or request a new one.");
    } else if (result.nextStep.signInStep === "RESET_PASSWORD") {
      await startReset();
    } else {
      setChallenge(result.nextStep);
      setStep("challenge");
    }
  }

  // A ref prevents a second submission before React renders the disabled controls.
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (err) {
      if (err instanceof Error && err.name === "UserNotConfirmedException") {
        setStep("verify");
        setPassword("");
      }
      setError(authErrorMessage(err));
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      if (step === "verified") {
        setStep("form");
        setPage("login");
      } else if (step === "verify") {
        const result = await confirmSignUp({ username, confirmationCode: code.trim() });
        if (result.isSignUpComplete) {
          setStep(page === "login" ? "form" : "verified");
          setCode("");
          setMessage("Email verified. Please sign in.");
        } else {
          setMessage("Verification is not complete. Enter the latest code or request a new one.");
        }
      } else if (step === "reset-code") {
        await confirmResetPassword({ username, confirmationCode: code.trim(), newPassword });
        setNewPassword("");
        setCode("");
        setStep("form");
        setPage("login");
        setMessage("Password reset. Please sign in with your new password.");
      } else if (step === "challenge" && challenge) {
        const options = challenge.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
          ? { userAttributes: attributes } : undefined;
        await handleSignInResult(await confirmSignIn({
          challengeResponse: responseIsPassword ? response : response.trim(), options,
        }));
      } else if (page === "signup") {
        const result = await signUp({
          username, password,
          options: { userAttributes: { email: username, given_name: firstName.trim(), family_name: lastName.trim() } },
        });
        setPassword("");
        setStep(result.nextStep.signUpStep === "CONFIRM_SIGN_UP" ? "verify" : "verified");
      } else if (page === "login") {
        await handleSignInResult(await signIn({ username, password }));
      } else {
        await startReset();
      }
    });
  }

  const challengeLabel = challenge ? challengeLabels[challenge.signInStep] : undefined;
  const responseIsPassword = challenge?.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
    || challenge?.signInStep === "CONFIRM_SIGN_IN_WITH_PASSWORD";
  const choices = challenge?.signInStep === "CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION"
    ? challenge.availableChallenges
    : challenge?.signInStep === "CONTINUE_SIGN_IN_WITH_MFA_SELECTION"
      ? challenge.allowedMFATypes ?? ["SMS", "TOTP"]
      : challenge?.signInStep === "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION"
        ? challenge.allowedMFATypes ?? ["EMAIL", "TOTP"] : undefined;
  const missingAttributes = challenge?.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
    ? challenge.missingAttributes ?? [] : [];

  return (
    <div className="auth-shell">
      <div className="auth-brand" onClick={() => { if (!loading) setPage("landing"); }}>
        <Brand />
      </div>
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <form onSubmit={submit} style={{ display: "contents" }} aria-busy={loading}>
        <Card className="auth-card">
          <div className="auth-icon">
            <Icon name={page === "reset" ? "mail" : "spark"} size={24} />
          </div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {step === "form" && page === "signup" && (
            <div className="form-row">
              <Field label="First name" name="given_name" autoComplete="given-name" placeholder="Maya" value={firstName} onChange={(e) => setFirstName(e.target.value)} required pattern=".*\S.*" disabled={loading} />
              <Field label="Last name" name="family_name" autoComplete="family-name" placeholder="Bennett" value={lastName} onChange={(e) => setLastName(e.target.value)} required pattern=".*\S.*" disabled={loading} />
            </div>
          )}
          {step !== "verified" && (
            <Field label="Email address" name="email" type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required readOnly={step !== "form"} disabled={loading} />
          )}
          {step === "form" && page !== "reset" && (
            <Field label="Password" name="password" type="password" autoComplete={page === "signup" ? "new-password" : "current-password"} placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={page === "signup" ? 8 : undefined} disabled={loading} />
          )}
          {step === "form" && page === "signup" && <Field label="Your event type" placeholder="Wedding" disabled={loading} />}
          {(step === "verify" || step === "reset-code") && (
            <Field label="Verification code" name="code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required pattern=".*\S.*" disabled={loading} />
          )}
          {step === "reset-code" && (
            <Field label="New password" name="newPassword" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required disabled={loading} />
          )}
          {step === "challenge" && challenge && (
            <>
              {challenge.signInStep === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP" && (
                <p>In your authenticator app, add an account using this setup key: <code>{challenge.totpSetupDetails.sharedSecret}</code>. Then enter the generated code.</p>
              )}
              {challenge.signInStep === "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE" && <p>{challenge.additionalInfo?.hint ?? "Enter the response required by your account's authentication challenge."}</p>}
              {"codeDeliveryDetails" in challenge && challenge.codeDeliveryDetails?.destination && <p>Code sent to {challenge.codeDeliveryDetails.destination}.</p>}
              {choices ? (
                <label className="field">
                  <span>{challengeLabel}</span>
                  <select value={response} onChange={(e) => setResponse(e.target.value)} required disabled={loading}>
                    <option value="">Choose a method</option>
                    {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                  </select>
                </label>
              ) : challengeLabel ? (
                <Field label={challengeLabel} type={responseIsPassword ? "password" : challenge.signInStep === "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP" ? "email" : "text"} autoComplete={responseIsPassword ? (challenge.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" ? "new-password" : "current-password") : "one-time-code"} value={response} onChange={(e) => setResponse(e.target.value)} required minLength={challenge.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" ? 8 : undefined} disabled={loading} />
              ) : <p role="alert">This account requires a sign-in method that is unavailable here. Contact your administrator. Your dashboard remains locked.</p>}
              {missingAttributes.map((attribute) => (
                <Field key={attribute} label={attribute.replaceAll("_", " ")} value={attributes[attribute] ?? ""} onChange={(e) => setAttributes((current) => ({ ...current, [attribute]: e.target.value }))} required disabled={loading} />
              ))}
            </>
          )}
          {step === "form" && page === "login" && (
            <button type="button" className="text-link forgot" disabled={loading} onClick={() => setPage("reset")}>
              Forgot password?
            </button>
          )}
          <Button type="submit" disabled={loading || (step === "challenge" && !challengeLabel)}>
            {loading ? "Please wait?" : step === "verify" ? "Verify email" : step === "reset-code" ? "Reset password" : step === "challenge" ? "Continue" : step === "verified" || page === "login" ? "Sign in" : page === "signup" ? "Create my account" : "Send reset code"}{" "}
            <Icon name="arrow" size={16} />
          </Button>
          {(step === "verify" || step === "reset-code") && (
            <button type="button" className="text-link" disabled={loading} onClick={() => void run(async () => {
              if (step === "verify") {
                await resendSignUpCode({ username });
                setMessage("A new verification code has been sent to your email.");
              } else {
                await startReset();
              }
            })}>Resend verification code</button>
          )}
          {page !== "reset" && (
            <div className="auth-switch">
              {page === "login" ? "New to EventWise?" : "Already have an account?"}{" "}
              <button type="button" disabled={loading} onClick={() => setPage(page === "login" ? "signup" : "login")}>
                {page === "login" ? "Create account" : "Sign in"}
              </button>
            </div>
          )}
          {(page === "reset" || (page === "login" && step !== "form")) && (
            <button type="button" className="back-link" disabled={loading} onClick={() => { setStep("form"); setChallenge(null); setResponse(""); setAttributes({}); setNewPassword(""); setCode(""); setError(""); setMessage(""); setPage("login"); }}>
              Back to sign in
            </button>
          )}
        </Card>
      </form>
    </div>
  );
}
