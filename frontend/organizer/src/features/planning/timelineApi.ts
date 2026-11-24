// Organizer calls to the Timeline API (Feature 13). Contract: docs/api/timeline.md.
// Every call sends the Cognito access token; a missing or expired session throws
// EventSessionError so the page can send the user back to sign in.

import { apiUrl } from "../../services/apiConfig";
import { EventSessionError, authenticatedEventRequest } from "../events/services/eventApi";
import type { NotificationResult, TimelineFields, TimelineItem } from "./timelineFormat";

export class TimelineApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "TimelineApiError";
  }
}

export interface UpdateResult {
  item: TimelineItem;
  changedFields: string[];
  notification: NotificationResult;
}

const friendly: Record<string, string> = {
  FORBIDDEN: "You no longer have access to this event.",
  NOT_FOUND: "This activity was already removed. The timeline has been refreshed.",
  VERSION_CONFLICT: "Someone else just changed this activity. The timeline has been refreshed; please make your change again.",
  TIMELINE_FULL: "This event already has 100 activities, the most a timeline can hold.",
  VALIDATION_ERROR: "Check the highlighted fields.",
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = await authenticatedEventRequest();
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${token.toString()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new TimelineApiError("We couldn't reach the server. Check your connection and try again.", 0, "NETWORK");
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (response.ok) return body as T;
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  const code: string = typeof body?.error?.code === "string" ? body.error.code : "ERROR";
  throw new TimelineApiError(
    friendly[code] ?? "Something went wrong. Please try again.",
    response.status,
    code,
    body?.error?.fields ?? {},
  );
}

const base = (eventId: string) => `/events/${encodeURIComponent(eventId)}/timeline`;

export async function listTimeline(eventId: string, signal?: AbortSignal): Promise<TimelineItem[]> {
  const list = await request<{ eventId: string; items: TimelineItem[] }>(base(eventId), { signal });
  if (list?.eventId !== eventId || !Array.isArray(list.items)) {
    throw new TimelineApiError("We couldn't read this event's timeline. Please try again.", 200, "INVALID_RESPONSE");
  }
  return list.items;
}

export function createTimelineItem(eventId: string, fields: TimelineFields): Promise<TimelineItem> {
  return request(base(eventId), { method: "POST", body: JSON.stringify(fields) });
}

export function updateTimelineItem(
  eventId: string,
  itemId: string,
  version: number,
  changes: Partial<TimelineFields>,
  notify: boolean,
): Promise<UpdateResult> {
  return request(`${base(eventId)}/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...changes, version, notify }),
  });
}

export async function deleteTimelineItem(eventId: string, itemId: string, notify: boolean): Promise<void> {
  await request<void>(`${base(eventId)}/${encodeURIComponent(itemId)}${notify ? "?notify=true" : ""}`, { method: "DELETE" });
}

// --- Guest sharing ------------------------------------------------------------------

export interface ShareLink {
  share: string;
  url: string;
}

/** The event's guest timeline link (members only). */
export function getTimelineShareLink(eventId: string, signal?: AbortSignal): Promise<ShareLink> {
  return request(`${base(eventId)}/share`, { signal });
}

export interface GuestTimelineItem {
  itemId: string;
  title: string;
  place: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string | null;
}

export interface GuestTimeline {
  event: { name: string; eventDate: string | null; venue: string | null };
  items: GuestTimelineItem[];
}

export class GuestTimelineError extends Error {
  constructor(message: string, readonly notFound: boolean) {
    super(message);
    this.name = "GuestTimelineError";
  }
}

/** Public: no sign-in. The share token in the URL is the only credential, so never send a referrer. */
export async function fetchGuestTimeline(share: string, signal?: AbortSignal): Promise<GuestTimeline> {
  let response: Response;
  try {
    response = await fetch(apiUrl(`/guest-timeline/${encodeURIComponent(share)}`), {
      signal, referrerPolicy: "no-referrer", cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new GuestTimelineError("We couldn't reach the server. Check your connection and try again.", false);
  }
  if (response.status === 404) {
    throw new GuestTimelineError("This timeline link isn't valid. Ask the hosts for a new one.", true);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.event || !Array.isArray(body.items)) {
    throw new GuestTimelineError("The timeline is temporarily unavailable. Please try again soon.", false);
  }
  return body as GuestTimeline;
}
