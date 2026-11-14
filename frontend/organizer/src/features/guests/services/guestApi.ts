import { mockGuestListResponse } from "./guestMockData";

// Guest list from the staging API Gateway: GET <url>?eventId=<id> returns { count, guests }.
// The URL is public configuration; set VITE_GUESTS_API_URL to point at another stage.

/**
 * Hardcoded guests are used until the backend is ready. Set VITE_GUESTS_USE_MOCK=false
 * to call the real API instead.
 */
export const GUESTS_USE_MOCK = import.meta.env.VITE_GUESTS_USE_MOCK !== "false";

const GUESTS_API_URL = (
  import.meta.env.VITE_GUESTS_API_URL ??
  "https://cw5hmsb1e6.execute-api.us-west-2.amazonaws.com/staging/guest"
).replace(/\/$/, "");

/** The only RSVP statuses the guest API returns. */
export const RSVP_STATUSES = ["UNINVITED", "PENDING", "ACCEPTED", "REJECTED"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** Display names for each RSVP status, shared by the table, filter and edit form. */
export const RSVP_LABELS: Record<RsvpStatus, string> = {
  UNINVITED: "Uninvited",
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
};

export function isRsvpStatus(value: unknown): value is RsvpStatus {
  return typeof value === "string" && (RSVP_STATUSES as readonly string[]).includes(value);
}

export interface GuestRecord {
  guestId: string;
  eventId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  plusOneAllowed: boolean;
  mealChoice: string | null;
  dietaryNotes: string | null;
  rsvpStatus: RsvpStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

export class GuestApiError extends Error {}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function parseGuest(row: unknown): GuestRecord {
  if (!row || typeof row !== "object") throw new GuestApiError("The guest service returned an invalid guest.");
  const guest = row as Record<string, unknown>;
  const guestId = text(guest.guestId);
  if (!guestId) throw new GuestApiError("The guest service returned a guest without an ID.");
  if (!isRsvpStatus(guest.rsvpStatus)) {
    throw new GuestApiError("The guest service returned a guest with an unknown RSVP status.");
  }
  return {
    guestId,
    eventId: text(guest.eventId) ?? "",
    firstName: text(guest.firstName),
    lastName: text(guest.lastName),
    email: text(guest.email),
    plusOneAllowed: guest.plusOneAllowed === true,
    mealChoice: text(guest.mealChoice),
    dietaryNotes: text(guest.dietaryNotes),
    rsvpStatus: guest.rsvpStatus,
    createdAt: text(guest.createdAt),
    updatedAt: text(guest.updatedAt),
  };
}

/** Validates a `{ count, guests }` response body. */
function parseGuestList(body: unknown): GuestRecord[] {
  const list = body as { guests?: unknown } | null;
  if (!list || !Array.isArray(list.guests)) {
    throw new GuestApiError("The guest service returned an unexpected response.");
  }
  return list.guests.map(parseGuest);
}

export async function listGuests(eventId: string): Promise<GuestRecord[]> {
  if (GUESTS_USE_MOCK) {
    // Short delay so the loading state behaves as it will with the real API.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    return parseGuestList(structuredClone(mockGuestListResponse));
  }

  let response: Response;
  try {
    response = await fetch(`${GUESTS_API_URL}?eventId=${encodeURIComponent(eventId)}`);
  } catch {
    throw new GuestApiError("We couldn't reach the guest service. Check your connection and try again.");
  }
  if (!response.ok) throw new GuestApiError("Unable to load your guest list. Please try again.");
  return parseGuestList(await response.json().catch(() => null));
}
