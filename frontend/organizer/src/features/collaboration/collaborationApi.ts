import { apiUrl } from "../../services/apiConfig";
import { getCurrentUser, inspectAuthSession } from "../auth/services/authService";
import { authenticatedEventRequest, EventSessionError, requestEventId, type OrganizerEvent } from "../events/services/eventApi";

export interface EventMember {
  member_id: string;
  role: OrganizerEvent["role"];
  joined_at: string;
  is_self: boolean;
}

export class EventMembersError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const loadError = "Unable to load event members. Please try again.";
const inviteError = "Unable to load invitations. Please try again.";
const denied = "You no longer have access to this event. Select another event or refresh your event list.";
const ownerRequired = "Only the event owner can manage this planning team.";

export interface PendingInvitation {
  invitation_id: string;
  email: string;
  status: "PENDING";
  expires_at: string;
  created_at: string;
}

export interface CreatedInvitation extends PendingInvitation {
  acceptance_url: string;
  email_status?: "not_configured" | "queued" | "retryable";
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseMembers(body: unknown): EventMember[] {
  const invalid = () => new EventMembersError(502, loadError);
  if (!Array.isArray(body)) throw invalid();
  return body.map((item: unknown) => {
    if (!item || typeof item !== "object") throw invalid();
    const { member_id, role, joined_at, is_self } = item as Record<string, unknown>;
    if (!isId(member_id) || (role !== "OWNER" && role !== "CO_PLANNER") || !isTimestamp(joined_at) || typeof is_self !== "boolean") {
      throw invalid();
    }
    return { member_id, role, joined_at, is_self };
  });
}

function parseInvitation(body: unknown, message: string): PendingInvitation {
  if (!body || typeof body !== "object") throw new EventMembersError(502, message);
  const { invitation_id, email, status, expires_at, created_at } = body as Record<string, unknown>;
  if (!isId(invitation_id) || typeof email !== "string" || !email || status !== "PENDING" ||
      !isTimestamp(expires_at) || !isTimestamp(created_at)) throw new EventMembersError(502, message);
  return { invitation_id, email, status, expires_at, created_at };
}

async function collaborationRequest(path: string, options: {
  method?: "POST" | "DELETE"; userId?: string; signal?: AbortSignal; body?: object;
  message: string; errors?: Record<number, string>; expected?: number;
  retryStatus?: number;
}) {
  const { signal, method, body, message, errors = {}, expected = 200 } = options;
  const identity = await authenticatedEventRequest();
  const accountChanged = () => new EventMembersError(409, "Your account changed. Please refresh your events.");
  signal?.throwIfAborted();
  if (options.userId !== undefined && identity.user.userId !== options.userId) throw accountChanged();

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method, signal,
      headers: { Authorization: `Bearer ${identity.token.toString()}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    signal?.throwIfAborted();
    throw new EventMembersError(0, message);
  }
  if (response.status === 401) {
    signal?.throwIfAborted();
    const session = await inspectAuthSession();
    signal?.throwIfAborted();
    if (session.status === "invalid") throw new EventSessionError("Your session has expired. Please sign in again.");
    if (session.status === "active" && session.userId !== identity.user.userId) throw accountChanged();
    throw new EventMembersError(401, session.status === "active"
      ? "The Co-planners API rejected this request. Your session is still active. Please try again."
      : "Unable to verify your sign-in right now. Please try again.");
  }
  if (response.status !== expected && response.status !== options.retryStatus) {
    throw new EventMembersError(response.status, errors[response.status] ?? message);
  }
  const data: unknown = expected === 204 ? null : await response.json().catch(() => { throw new EventMembersError(502, message); });
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  signal?.throwIfAborted();
  if (current.userId !== identity.user.userId) throw accountChanged();
  return { data, userId: current.userId };
}

export async function listEventMembers(eventId: string, userId: string, signal?: AbortSignal): Promise<EventMember[]> {
  const { data } = await collaborationRequest(`/events/${requestEventId(eventId)}/members`, {
    userId, signal, message: loadError, errors: { 403: denied },
  });
  return parseMembers(data);
}

export async function listPendingInvitations(eventId: string, userId: string, signal?: AbortSignal): Promise<PendingInvitation[]> {
  const { data } = await collaborationRequest(`/events/${requestEventId(eventId)}/invitations`, {
    userId, signal, message: inviteError, errors: { 403: ownerRequired },
  });
  if (!Array.isArray(data)) throw new EventMembersError(502, inviteError);
  return data.map(item => parseInvitation(item, inviteError));
}

export async function createInvitation(eventId: string, userId: string, email: string, signal?: AbortSignal): Promise<CreatedInvitation> {
  const message = "Unable to create the invitation. Please try again.";
  const { data } = await collaborationRequest(`/events/${requestEventId(eventId)}/invitations`, {
    method: "POST", userId, signal, body: { email: email.trim() }, expected: 201, retryStatus: 200, message,
    errors: { 400: "Enter a valid email address.", 403: ownerRequired, 409: "A pending invitation already exists for this email." },
  });
  const invitation = parseInvitation(data, "The invitation was created, but its link could not be read. Refresh the invitations before creating another.");
  const { acceptance_url: value, email_status } = data as Record<string, unknown>;
  let url: URL;
  try {
    if (typeof value !== "string") throw new Error();
    url = new URL(value);
    const localHttp = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]+)?\/accept-invitation#/i.test(value);
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search ||
        url.pathname !== "/accept-invitation" || !url.hash.startsWith("#token=") || !isInvitationToken(url.hash.slice(7))) throw new Error();
  } catch {
    throw new EventMembersError(502, "The invitation was created, but its link could not be read. Refresh the invitations before creating another.");
  }
  return { ...invitation, acceptance_url: url.href,
    ...(email_status === "queued" || email_status === "retryable" || email_status === "not_configured" ? { email_status } : {}),
  };
}

export async function revokeInvitation(eventId: string, invitationId: string, userId: string, signal?: AbortSignal): Promise<void> {
  await collaborationRequest(`/events/${requestEventId(eventId)}/invitations/${requestEventId(invitationId)}`, {
    method: "DELETE", userId, signal, expected: 204, message: "Unable to revoke the invitation. Please try again.",
    errors: { 403: ownerRequired, 404: "This invitation is no longer available.", 409: "This invitation has already expired or been accepted." },
  });
}

export async function removeEventMember(eventId: string, memberId: string, userId: string, signal?: AbortSignal): Promise<void> {
  await collaborationRequest(`/events/${requestEventId(eventId)}/members/${requestEventId(memberId)}`, {
    method: "DELETE", userId, signal, expected: 204, message: "Unable to remove the co-planner. Please try again.",
    errors: { 403: ownerRequired, 404: "This co-planner is no longer on the planning team.", 409: "This membership has a conflicting task assignment or cannot be removed." },
  });
}

export async function acceptInvitation(token: string, signal?: AbortSignal): Promise<{
  userId: string; event_id: string; member_id: string; role: "CO_PLANNER";
}> {
  if (!isInvitationToken(token)) throw new EventMembersError(400, "This invitation link is invalid.");
  const message = "Unable to accept the invitation. Please try again.";
  const { data, userId } = await collaborationRequest("/event-invitations/accept", {
    method: "POST", signal, body: { token }, message,
    errors: {
      400: "This invitation link is invalid.",
      403: "Sign in with the verified email address that received this invitation.",
      404: "This invitation could not be found.",
      409: "This invitation was already accepted or you already belong to the event.",
      410: "This invitation has expired or been revoked.",
      503: "Email verification is temporarily unavailable. Please try again.",
    },
  });
  if (!data || typeof data !== "object") throw new EventMembersError(502, message);
  const { event_id, member_id, role } = data as Record<string, unknown>;
  if (!isId(event_id) || !isId(member_id) || role !== "CO_PLANNER") throw new EventMembersError(502, message);
  return { userId, event_id, member_id, role };
}
