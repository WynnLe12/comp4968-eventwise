// Guest numbers for the event dashboard (Feature 10): RSVP counts and planned headcount.
// See docs/api/dashboard.md ("Guests").

import { GuestRepository } from "../repositories/guestRepository";
import { RSVP_STATUSES, type RsvpStatus } from "../types";
import { calculateHeadcount } from "./headcount";

export interface GuestSummary {
  /** Guest entries in the table for this event. */
  records: number;
  /** Entries that may bring a plus-one. */
  plusOnes: number;
  /** records + plusOnes, same rule as the Guests page total. */
  expectedHeadcount: number;
  /** Entries per stored RSVP status. */
  rsvp: Record<RsvpStatus, number>;
}

/** Only these two fields are needed, so items written by any guest API version work. */
type CountableGuest = { plusOneAllowed?: unknown; rsvpStatus?: unknown };

const isRsvpStatus = (value: unknown): value is RsvpStatus =>
  typeof value === "string" && (RSVP_STATUSES as readonly string[]).includes(value);

/**
 * Counts guests by RSVP status and computes the planned headcount.
 * An item without a status has not been invited yet, so it counts as UNINVITED.
 * An unknown status is left out of `rsvp` (but still counts in `records`), so a new
 * Feature 8 status never shows up as the wrong answer.
 */
export function summarizeGuests(guests: readonly CountableGuest[]): GuestSummary {
  const rsvp = Object.fromEntries(RSVP_STATUSES.map((status) => [status, 0])) as Record<RsvpStatus, number>;
  for (const guest of guests) {
    if (guest.rsvpStatus === undefined || guest.rsvpStatus === null) rsvp.UNINVITED += 1;
    else if (isRsvpStatus(guest.rsvpStatus)) rsvp[guest.rsvpStatus] += 1;
  }
  const headcount = calculateHeadcount(guests.map((guest) => ({ plusOneAllowed: guest.plusOneAllowed === true })));
  return {
    records: headcount.invited,
    plusOnes: headcount.plusOnes,
    expectedHeadcount: headcount.expectedTotal,
    rsvp,
  };
}

/** Reads every guest of the event from DynamoDB and summarizes them. */
export async function loadGuestSummary(
  eventId: string,
  repository: Pick<GuestRepository, "listByEvent"> = new GuestRepository(),
): Promise<GuestSummary> {
  return summarizeGuests(await repository.listByEvent(eventId));
}
