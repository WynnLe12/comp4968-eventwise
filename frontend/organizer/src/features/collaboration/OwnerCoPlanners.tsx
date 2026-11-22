import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { Button, Card, Field, Icon, Modal } from "../../components/ui";
import { EventSessionError } from "../events/services/eventApi";
import {
  createInvitation, EventMembersError, listPendingInvitations, removeEventMember, revokeInvitation,
  type CreatedInvitation, type EventMember, type PendingInvitation,
} from "./collaborationApi";

type Dialog = { kind: "invite" } | { kind: "revoke"; invitation: PendingInvitation } | { kind: "remove"; member: EventMember };
type PendingState = { invitations: PendingInvitation[] } | { error: string } | null;

const expiryFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

function expiry(timestamp: string) {
  return <time dateTime={timestamp}>{expiryFormat.format(new Date(timestamp))}</time>;
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof EventMembersError || error instanceof EventSessionError ? error.message : fallback;
}

export function OwnerCoPlanners({ eventId, userId, isCurrentEvent, onSessionExpired, onRosterChange, renderRoster }: {
  eventId: string;
  userId: string;
  isCurrentEvent: (userId: string, eventId: string) => boolean;
  onSessionExpired: () => void;
  onRosterChange: () => void;
  renderRoster: (onRemove: (member: EventMember) => void) => ReactNode;
}) {
  const [state, setState] = useState<PendingState>(null);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const mutation = useRef<AbortController | null>(null);
  const pendingList = useRef<AbortController | null>(null);
  const copyVersion = useRef(0);
  const sessionExpired = useRef(onSessionExpired);
  const formId = useId();

  useEffect(() => { sessionExpired.current = onSessionExpired; }, [onSessionExpired]);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    pendingList.current = controller;
    const active = () => !controller.signal.aborted && isCurrentEvent(userId, eventId);
    void listPendingInvitations(eventId, userId, controller.signal).then(invitations => {
      if (active()) setState({ invitations });
    }).catch((failure: unknown) => {
      if (!active()) return;
      setState({ error: messageFor(failure, "Unable to load invitations. Please try again.") });
      if (failure instanceof EventSessionError) sessionExpired.current();
    });
    return () => controller.abort();
  }, [eventId, userId, isCurrentEvent, revision]);

  function reload() {
    pendingList.current?.abort();
    setState(null);
    setRevision(value => value + 1);
  }

  function closeDialog() {
    if (mutation.current) return;
    ++copyVersion.current;
    setDialog(null);
    setEmail("");
    setFieldError("");
    setError("");
    setCreated(null);
    setCopyStatus("");
  }

  function openDialog(next: Dialog) {
    setDialog(previous => previous ?? next);
  }

  async function submit() {
    if (!dialog || mutation.current || created || !isCurrentEvent(userId, eventId)) return;
    const address = email.trim();
    if (dialog.kind === "invite" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254)) {
      setFieldError("Enter a valid email address.");
      return;
    }
    const controller = new AbortController();
    mutation.current = controller;
    const active = () => !controller.signal.aborted && isCurrentEvent(userId, eventId);
    setBusy(true);
    setError("");
    setFieldError("");
    try {
      if (dialog.kind === "invite") {
        const invitation = await createInvitation(eventId, userId, address, controller.signal);
        if (!active()) return;
        setCreated(invitation);
        reload();
      } else if (dialog.kind === "revoke") {
        await revokeInvitation(eventId, dialog.invitation.invitation_id, userId, controller.signal);
        if (!active()) return;
        setDialog(null);
        reload();
      } else {
        await removeEventMember(eventId, dialog.member.member_id, userId, controller.signal);
        if (!active()) return;
        setDialog(null);
        onRosterChange();
      }
    } catch (failure) {
      if (!active()) return;
      if (dialog.kind === "invite" && failure instanceof EventMembersError && failure.status === 400) {
        setFieldError(failure.message);
      } else {
        setError(messageFor(failure, "Unable to complete the request. Please try again."));
      }
      if (failure instanceof EventSessionError) sessionExpired.current();
    } finally {
      mutation.current = null;
      if (active()) setBusy(false);
    }
  }

  async function copyLink() {
    if (!created || !isCurrentEvent(userId, eventId)) return;
    const version = ++copyVersion.current;
    const active = () => version === copyVersion.current && isCurrentEvent(userId, eventId);
    try {
      await navigator.clipboard.writeText(created.acceptance_url);
      if (active()) setCopyStatus("Link copied.");
    } catch {
      if (active()) setCopyStatus("Select the link and copy it manually.");
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return <>
    <PageHeader page="coplanners" action={<Button icon="userplus" onClick={() => openDialog({ kind: "invite" })}>Invite Co-planner</Button>} />
    {renderRoster(member => openDialog({ kind: "remove", member }))}
    <Card className="collaboration-invitations">
      <div className="card-head"><div><h3>Pending invitations</h3></div></div>
      {!state ? <LoadingState label="Loading invitations..." /> : "error" in state ? <ErrorState message={state.error} onRetry={reload} />
        : state.invitations.length === 0 ? <EmptyState title="No pending invitations" message="New invitations will appear here." icon="mail" />
        : <ul className="people-list" role="list">
            {state.invitations.map(invitation => <li className="person-row collaboration-action-row" key={invitation.invitation_id}>
              <span><Icon name="mail" size={16} /></span>
              <div><b>{invitation.email}</b><p>Pending · Expires {expiry(invitation.expires_at)}</p></div>
              <Button variant="ghost" onClick={() => openDialog({ kind: "revoke", invitation })}>Revoke</Button>
            </li>)}
          </ul>}
    </Card>
    {dialog?.kind === "invite" && <Modal title="Invite Co-planner" onClose={closeDialog} footer={created
      ? <Button onClick={closeDialog}>Done</Button>
      : <>
        <Button variant="secondary" disabled={busy} onClick={closeDialog}>Cancel</Button>
        <Button type="submit" form={formId} disabled={busy}>{busy ? "Creating..." : "Create Invitation"}</Button>
      </>}>
      {created ? <>
        <p>Share this link with {created.email}. It expires {expiry(created.expires_at)}.</p>
        <Field label="Invitation link" value={created.acceptance_url} readOnly onFocus={event => event.currentTarget.select()} />
        <Button variant="secondary" onClick={() => void copyLink()}>Copy Link</Button>
        {copyStatus && <p role="status">{copyStatus}</p>}
      </> : <form id={formId} onSubmit={submitForm} noValidate>
        <Field label="Email address" type="email" autoComplete="email" required maxLength={254}
          disabled={busy} value={email} error={fieldError}
          onChange={event => { setEmail(event.target.value); setFieldError(""); setError(""); }} />
        {error && <p className="expense-form-error" role="alert">{error}</p>}
      </form>}
    </Modal>}
    {(dialog?.kind === "revoke" || dialog?.kind === "remove") && <Modal
      title={dialog.kind === "revoke" ? "Revoke invitation?" : "Remove co-planner?"}
      onClose={closeDialog} footer={<>
        <Button variant="secondary" disabled={busy} onClick={closeDialog}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={() => void submit()}>
          {dialog.kind === "revoke" ? busy ? "Revoking..." : "Revoke Invitation" : busy ? "Removing..." : "Remove Co-planner"}
        </Button>
      </>}>
      {dialog.kind === "revoke"
        ? <p>The invitation link for <strong>{dialog.invitation.email}</strong> will stop working.</p>
        : <p><strong>Member #{dialog.member.member_id}</strong> will lose access to this event. Their assigned tasks will become unassigned.</p>}
      {error && <p className="expense-form-error" role="alert">{error}</p>}
    </Modal>}
  </>;
}
