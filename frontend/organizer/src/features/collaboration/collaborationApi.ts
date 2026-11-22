import { apiUrl } from "../../services/apiConfig";
import { getCurrentUser } from "../auth/services/authService";
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

function parseMembers(body: unknown): EventMember[] {
  const invalid = () => new EventMembersError(502, loadError);
  if (!Array.isArray(body)) throw invalid();
  return body.map((item: unknown) => {
    if (!item || typeof item !== "object") throw invalid();
    const { member_id, role, joined_at, is_self } = item as Record<string, unknown>;
    if (typeof member_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(member_id) ||
        BigInt(member_id) > 18446744073709551615n || (role !== "OWNER" && role !== "CO_PLANNER") ||
        typeof joined_at !== "string" || !Number.isFinite(Date.parse(joined_at)) ||
        new Date(joined_at).toISOString() !== joined_at || typeof is_self !== "boolean") {
      throw invalid();
    }
    return { member_id, role, joined_at, is_self };
  });
}

export async function listEventMembers(eventId: string, userId: string, signal?: AbortSignal): Promise<EventMember[]> {
  const id = requestEventId(eventId);
  const identity = await authenticatedEventRequest();
  const accountChanged = () => new EventMembersError(409, "Your account changed. Please refresh your events.");
  signal?.throwIfAborted();
  if (identity.user.userId !== userId) throw accountChanged();

  const response = await fetch(apiUrl(`/events/${id}/members`), {
    headers: { Authorization: `Bearer ${identity.token.toString()}` },
    signal,
  });
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (response.status === 403) throw new EventMembersError(403, "You no longer have access to this event. Select another event or refresh your event list.");
  if (!response.ok) throw new EventMembersError(response.status, loadError);
  const members = parseMembers(await response.json());
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  signal?.throwIfAborted();
  if (current.userId !== userId) throw accountChanged();
  return members;
}
