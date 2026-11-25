// Headcount rules for the guest list. The row's party size and the page total use
// the same function, so a guest with a plus-one always counts as two people.
// Matches calculateHeadcount() in backend/guest-service/services/headcount.ts.

/** People in one guest record: the guest, plus one more if a plus-one is allowed. */
export function partySize(guest: { plusOneAllowed: boolean }): number {
  return guest.plusOneAllowed ? 2 : 1;
}

/** Total people across all guest records, plus-ones included. */
export function totalHeadcount(guests: readonly { plusOneAllowed: boolean }[]): number {
  return guests.reduce((total, guest) => total + partySize(guest), 0);
}

/**
 * People per RSVP status, plus-ones included: a guest with a plus-one adds 2 to its
 * status, so the counts add up to totalHeadcount(). The plus-one is assumed to follow
 * the guest's answer until Feature 8 records whether it is coming. Unknown statuses
 * are left out. Same rule as the dashboard (backend guestSummary.ts).
 */
export function peopleByStatus<S extends string>(
  guests: readonly { plusOneAllowed: boolean; rsvpStatus: string }[],
  statuses: readonly S[],
): Record<S, number> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<S, number>;
  for (const guest of guests) {
    if ((statuses as readonly string[]).includes(guest.rsvpStatus)) counts[guest.rsvpStatus as S] += partySize(guest);
  }
  return counts;
}
