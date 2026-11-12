import { getCurrentUser, requireAuthSession } from "../../auth/services/authService";

export interface OrganizerEvent {
  event_id: string;
  template_id: string | null;
  name: string;
  event_date: string | null;
  venue: string | null;
  total_budget: string;
  created_at: string;
  updated_at: string;
  role: "OWNER" | "CO_PLANNER";
}

export class EventSessionError extends Error {}

export function parseEvents(body: unknown): OrganizerEvent[] {
  if (!Array.isArray(body)) throw new Error("The event service returned an invalid response.");
  return body.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error("The event service returned an invalid event.");
    const event = row as Record<string, unknown>;
    if (typeof event.event_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(event.event_id)
      || BigInt(event.event_id) > 18446744073709551615n || typeof event.name !== "string"
      || (event.role !== "OWNER" && event.role !== "CO_PLANNER")
      || (event.template_id !== null && typeof event.template_id !== "string")
      || (event.event_date !== null && typeof event.event_date !== "string")
      || (event.venue !== null && typeof event.venue !== "string")
      || typeof event.total_budget !== "string" || !/^[0-9]+\.[0-9]{2}$/.test(event.total_budget)
      || typeof event.created_at !== "string" || typeof event.updated_at !== "string") {
      throw new Error("The event service returned an invalid event.");
    }
    // Project only the event fields returned by the list endpoint.
    return {
      event_id: event.event_id, template_id: event.template_id, name: event.name,
      event_date: event.event_date, venue: event.venue, total_budget: event.total_budget,
      created_at: event.created_at, updated_at: event.updated_at, role: event.role,
    };
  });
}

export async function listEvents(signal?: AbortSignal): Promise<{ userId: string; events: OrganizerEvent[] }> {
  let identity: Awaited<ReturnType<typeof requireAuthSession>>;
  try {
    identity = await requireAuthSession();
  } catch {
    throw new EventSessionError("Your session has expired. Please sign in again.");
  }
  const token = identity.session.tokens?.accessToken;
  if (!token) throw new EventSessionError("Please sign in again.");
  const response = await fetch("/api/events", {
    headers: { Authorization: `Bearer ${token.toString()}` }, signal,
  });
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (!response.ok) throw new Error("Unable to load your events. Please try again.");
  const events = parseEvents(await response.json());
  // Discard data if the account changed while the request was in flight.
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  if (current.userId !== identity.user.userId) throw new Error("Your account changed. Please reload your events.");
  return { userId: current.userId, events };
}
