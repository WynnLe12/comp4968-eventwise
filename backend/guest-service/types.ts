// Guest types shared by the guest service. See docs/api/guests.md for the API contract
// and database/dynamodb/guests.md for the DynamoDB table design.

/** RSVP is not editable in the MVP (Feature 8 owns it); new guests start as PENDING. */
export const RSVP_STATUSES = ["PENDING", "ATTENDING", "DECLINED"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** Fields an organizer may set on create or change on update. */
export interface GuestFields {
  firstName: string;
  lastName: string | null;
  email: string | null;
  group: string | null;
  plusOneAllowed: boolean;
  mealChoice: string | null;
  dietaryNotes: string | null;
}

/** Fields set when creating a guest. firstName is required; the rest default to null/false. */
export type NewGuest = Pick<GuestFields, "firstName"> & Partial<Omit<GuestFields, "firstName">>;

/** Partial update. A null value clears an optional field. */
export type GuestChanges = Partial<GuestFields>;

/**
 * One guest as stored in DynamoDB (table key: eventId + guestId).
 * Optional fields are omitted from the item when empty, never stored as null.
 */
export interface GuestItem {
  eventId: string;
  guestId: string;
  firstName: string;
  lastName?: string;
  email?: string;
  group?: string;
  plusOneAllowed: boolean;
  mealChoice?: string;
  dietaryNotes?: string;
  rsvpStatus: RsvpStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One guest as returned by the API. Empty optional fields are null. */
export interface Guest extends GuestFields {
  eventId: string;
  guestId: string;
  rsvpStatus: RsvpStatus;
  createdAt: string;
  updatedAt: string;
}

/** Planned headcount. Independent of RSVP answers (see services/headcount.ts). */
export interface Headcount {
  /** Number of guest records. */
  invited: number;
  /** Guests who may bring a plus-one. */
  plusOnes: number;
  /** invited + plusOnes. */
  expectedTotal: number;
}
