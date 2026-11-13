// Planned headcount for Feature 7.
//
// Counts guest records and allowed plus-ones. It deliberately ignores RSVP answers:
// the Feature 7 requirement is to "count planned guests and plus-ones without
// conflating with confirmed RSVP". RSVP-based counts belong to Feature 8.

import type { Headcount } from "../types";

export function calculateHeadcount(guests: readonly { plusOneAllowed: boolean }[]): Headcount {
  const invited = guests.length;
  const plusOnes = guests.filter((guest) => guest.plusOneAllowed).length;
  return { invited, plusOnes, expectedTotal: invited + plusOnes };
}
