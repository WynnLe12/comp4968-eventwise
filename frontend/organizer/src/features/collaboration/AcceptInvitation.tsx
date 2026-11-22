import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LoadingState } from "../../components/page";
import { Button, Card, Icon } from "../../components/ui";
import type { PublicPage } from "../../types";
import { PublicApp } from "../auth/PublicPage";
import { useUserProfile } from "../auth/hooks/useUserProfile";
import { rememberSelectedEvent } from "../events/EventsContext";
import { EventSessionError } from "../events/services/eventApi";
import { acceptInvitation, EventMembersError, isInvitationToken } from "./collaborationApi";

export const invitationAcceptancePath = "/accept-invitation";

export function readInvitationFragment(hash: string): string | null {
  if (!hash.startsWith("#token=")) return null;
  const token = hash.slice("#token=".length);
  return isInvitationToken(token) ? token : null;
}

export function AcceptInvitation({ authenticated, checkingSession, onAuthenticated, onSwitchAccount }: {
  authenticated: boolean;
  checkingSession: boolean;
  onAuthenticated: () => void;
  onSwitchAccount: () => void;
}) {
  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const [{ token, revision }, setInvitation] = useState(() => ({ token: readInvitationFragment(hash), revision: 0 }));
  const [authPage, setAuthPage] = useState<PublicPage>("login");

  useEffect(() => {
    if (!hash) return;
    setInvitation(previous => ({ token: readInvitationFragment(hash), revision: previous.revision + 1 }));
    // Keep the token only in this mounted route while the user completes auth.
    void navigate({ pathname, hash: "" }, { replace: true });
  }, [hash, navigate, pathname]);

  if (checkingSession) return <LoadingState label="Checking your session..." />;
  if (hash && readInvitationFragment(hash) !== token) return <LoadingState label="Opening invitation..." />;
  if (!token) return <div className="auth-shell"><Card className="auth-card">
    <h1>Invitation link unavailable</h1>
    <p>Open the original invitation link to continue.</p>
    <Button onClick={() => void navigate(authenticated ? "/app/dashboard" : "/login")}>{authenticated ? "Go to dashboard" : "Sign in"}</Button>
  </Card></div>;
  if (!authenticated) return <PublicApp page={authPage} setPage={page => {
    if (page === "landing") void navigate("/");
    else setAuthPage(page);
  }} enterApp={onAuthenticated} />;

  return <AcceptAsSignedInUser key={revision} token={token} onSwitchAccount={onSwitchAccount} />;
}

function AcceptAsSignedInUser({ token, onSwitchAccount }: { token: string; onSwitchAccount: () => void }) {
  const { profile } = useUserProfile();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EventMembersError | EventSessionError | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function accept() {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInvitation(token, request.signal);
      if (request.signal.aborted) return;
      rememberSelectedEvent(result.userId, result.event_id);
      void navigate("/app/dashboard", { replace: true });
    } catch (failure) {
      if (request.signal.aborted) return;
      setError(failure instanceof EventMembersError || failure instanceof EventSessionError
        ? failure : new EventMembersError(0, "Unable to accept the invitation. Please try again."));
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  const terminal = error instanceof EventSessionError
    || (error instanceof EventMembersError && [400, 403, 404, 409, 410].includes(error.status));
  return <div className="auth-shell"><Card className="auth-card">
    <div className="auth-icon"><Icon name="userplus" size={24} /></div>
    <h1>Accept co-planner invitation</h1>
    <p>{profile ? `Signed in as ${profile.displayName}. ` : ""}Use the account with the verified email address that received the invitation.</p>
    {error && <p role="alert">{error.message}</p>}
    <Button disabled={busy || terminal} onClick={() => void accept()}>{busy ? "Accepting..." : "Accept Invitation"}</Button>
    <Button variant="secondary" disabled={busy} onClick={onSwitchAccount}>{error instanceof EventSessionError ? "Sign in again" : "Switch account"}</Button>
  </Card></div>;
}
