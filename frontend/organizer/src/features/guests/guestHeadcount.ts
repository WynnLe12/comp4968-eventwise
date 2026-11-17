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
