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
 * People per RSVP status, plus-ones included, so the counts add up to totalHeadcount().
 * A plus-one follows the guest's answer, except when the guest ACCEPTED and said on the
 * RSVP form (Feature 8) that their plus-one isn't coming: that seat counts as REJECTED.
 * Unknown statuses are left out. Same rule as the dashboard (backend guestSummary.ts).
 */
export function peopleByStatus<S extends string>(
  guests: readonly { plusOneAllowed: boolean; rsvpStatus: string; plusOneAttending?: boolean | null }[],
  statuses: readonly S[],
): Record<S, number> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<S, number>;
  const known = (status: string): status is S => (statuses as readonly string[]).includes(status);
  for (const guest of guests) {
    if (!known(guest.rsvpStatus)) continue;
    counts[guest.rsvpStatus] += 1;
    if (!guest.plusOneAllowed) continue;
    const plusOneDeclined = guest.rsvpStatus === "ACCEPTED" && guest.plusOneAttending === false && known("REJECTED");
    counts[plusOneDeclined ? ("REJECTED" as S) : guest.rsvpStatus] += 1;
  }
  return counts;
}
