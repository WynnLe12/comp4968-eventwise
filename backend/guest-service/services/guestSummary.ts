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
  /**
   * People per stored RSVP status: a guest with a plus-one counts as 2, so the four
   * counts add up to expectedHeadcount. Same rule as the Guests page cards.
   */
  rsvp: Record<RsvpStatus, number>;
}

/** Only these two fields are needed, so items written by any guest API version work. */
type CountableGuest = { plusOneAllowed?: unknown; rsvpStatus?: unknown };

const isRsvpStatus = (value: unknown): value is RsvpStatus =>
  typeof value === "string" && (RSVP_STATUSES as readonly string[]).includes(value);

/**
 * Counts people by RSVP status and computes the planned headcount.
 * A guest with a plus-one counts as 2 people in its status: the plus-one is assumed to
 * follow the guest's answer until Feature 8 records whether the plus-one is coming.
 * An item without a status has not been invited yet, so it counts as UNINVITED.
 * An unknown status is left out of `rsvp` (but still counts in `records`), so a new
 * Feature 8 status never shows up as the wrong answer.
 */
export function summarizeGuests(guests: readonly CountableGuest[]): GuestSummary {
  const rsvp = Object.fromEntries(RSVP_STATUSES.map((status) => [status, 0])) as Record<RsvpStatus, number>;
  for (const guest of guests) {
    const people = guest.plusOneAllowed === true ? 2 : 1;
    if (guest.rsvpStatus === undefined || guest.rsvpStatus === null) rsvp.UNINVITED += people;
    else if (isRsvpStatus(guest.rsvpStatus)) rsvp[guest.rsvpStatus] += people;
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
