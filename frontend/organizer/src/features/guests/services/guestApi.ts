// Guest list from the staging API Gateway: GET <url>?eventId=<id> returns { count, guests }.
// The URL is public configuration; set VITE_GUESTS_API_URL to point at another stage.
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
  // A guest saved without a status (the create request doesn't send one) hasn't been invited yet.
  const rsvpStatus = guest.rsvpStatus ?? "UNINVITED";
  if (!isRsvpStatus(rsvpStatus)) {
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
    rsvpStatus,
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

/** Fields the "Add a guest" form collects. Empty optional fields are null. */
export interface NewGuestInput {
  firstName: string;
  lastName: string | null;
  email: string | null;
  plusOneAllowed: boolean;
}

/**
 * Creates a guest: PUT <GUESTS_API_URL> with body { guest: { eventId, guestId, ... } }.
 * The guest ID is generated here. Empty optional fields are left out of the body.
 * Returns the new guest's ID.
 */
export async function createGuest(eventId: string, input: NewGuestInput): Promise<string> {
  const guestId = crypto.randomUUID();
  const guest: Record<string, string | boolean> = {
    eventId,
    guestId,
    firstName: input.firstName,
    plusOneAllowed: input.plusOneAllowed,
  };
  if (input.lastName) guest.lastName = input.lastName;
  if (input.email) guest.email = input.email;

  let response: Response;
  try {
    // No Content-Type header on purpose: the gateway's CORS settings allow PUT but no request
    // headers, so a browser preflight for "application/json" would fail. A plain string body is
    // sent as text/plain, which needs no permission; the backend parses the JSON body either way.
    // Once the gateway allows the Content-Type header, add it here.
    response = await fetch(GUESTS_API_URL, { method: "PUT", body: JSON.stringify({ guest }) });
  } catch {
    throw new GuestApiError("We couldn't reach the guest service. Check your connection and try again.");
  }
  if (!response.ok) throw new GuestApiError("Unable to add this guest. Please try again.");
  return guestId;
}

/** Fields the edit form sends. A null value clears that field on the backend. */
export interface GuestChanges {
  firstName: string;
  lastName: string | null;
  email: string | null;
  plusOneAllowed: boolean;
  rsvpStatus: RsvpStatus;
  mealChoice: string | null;
}

/**
 * Updates one guest: PATCH <GUESTS_API_URL> with body { guest: { eventId, guestId, ...changes } }.
 * Sent without a Content-Type header for the same CORS reason as createGuest.
 */
export async function updateGuest(
  eventId: string,
  guestId: string,
  changes: GuestChanges,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(GUESTS_API_URL, {
      method: "PATCH",
      body: JSON.stringify({ guest: { eventId, guestId, ...changes } }),
    });
  } catch {
    throw new GuestApiError("We couldn't reach the guest service. Check your connection and try again.");
  }
  if (!response.ok) throw new GuestApiError("Unable to save this guest. Please try again.");
}

/**
 * Deletes one guest: DELETE <GUESTS_API_URL> with body { guest: { eventId, guestId } }.
 * Sent without a Content-Type header for the same CORS reason as createGuest.
 */
export async function deleteGuest(eventId: string, guestId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(GUESTS_API_URL, {
      method: "DELETE",
      body: JSON.stringify({ guest: { eventId, guestId } }),
    });
  } catch {
    throw new GuestApiError("We couldn't reach the guest service. Check your connection and try again.");
  }
  if (!response.ok) throw new GuestApiError("Unable to delete this guest. Please try again.");
}

/** Loads every guest of one event: GET <GUESTS_API_URL>?eventId=<eventId>. */
export async function listGuests(eventId: string): Promise<GuestRecord[]> {
  let response: Response;
  try {
    response = await fetch(`${GUESTS_API_URL}?eventId=${encodeURIComponent(eventId)}`);
  } catch {
    throw new GuestApiError("We couldn't reach the guest service. Check your connection and try again.");
  }
  if (!response.ok) throw new GuestApiError("Unable to load your guest list. Please try again.");
  return parseGuestList(await response.json().catch(() => null));
}
