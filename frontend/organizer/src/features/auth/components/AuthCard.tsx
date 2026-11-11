import { Brand } from "../../../components/layout";
import { Button, Card, Field, Icon } from "../../../components/ui";
import type { PublicPage } from "../../../types";

const authCopy: Record<Exclude<PublicPage, "landing">, [string, string]> = {
  login: ["Welcome back", "Sign in to continue planning the good stuff."],
  signup: ["Let’s plan something wonderful", "Create your free EventWise account."],
  reset: ["Reset your password", "We’ll send a secure reset link to your inbox."],
};

export function AuthCard({
  page,
  setPage,
  enterApp,
}: {
  page: Exclude<PublicPage, "landing">;
  setPage: (p: PublicPage) => void;
  enterApp: () => void;
}) {
  const [title, subtitle] = authCopy[page];
  return (
    <div className="auth-shell">
      <div className="auth-brand" onClick={() => setPage("landing")}>
        <Brand />
      </div>
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <Card className="auth-card">
        <div className="auth-icon">
          <Icon name={page === "reset" ? "mail" : "spark"} size={24} />
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        {page === "signup" && (
          <div className="form-row">
            <Field label="First name" placeholder="Maya" />
            <Field label="Last name" placeholder="Bennett" />
          </div>
        )}
        <Field label="Email address" type="email" placeholder="you@example.com" />
        {page !== "reset" && (
          <Field label="Password" type="password" placeholder="At least 8 characters" />
        )}
        {page === "signup" && <Field label="Your event type" placeholder="Wedding" />}
        {page === "login" && (
          <button className="text-link forgot" onClick={() => setPage("reset")}>
            Forgot password?
          </button>
        )}
        <Button onClick={page === "reset" ? () => setPage("login") : enterApp}>
          {page === "login" ? "Sign in" : page === "signup" ? "Create my account" : "Send reset link"}{" "}
          <Icon name="arrow" size={16} />
        </Button>
        {page !== "reset" && (
          <div className="auth-switch">
            {page === "login" ? "New to EventWise?" : "Already have an account?"}{" "}
            <button onClick={() => setPage(page === "login" ? "signup" : "login")}>
              {page === "login" ? "Create account" : "Sign in"}
            </button>
          </div>
        )}
        {page === "reset" && (
          <button className="back-link" onClick={() => setPage("login")}>
            Back to sign in
          </button>
        )}
      </Card>
    </div>
  );
}
