// Converts stored DynamoDB items into the API's Guest JSON (docs/api/guests.md).
// Optional fields are omitted in DynamoDB but always present (as null) in the API,
// and internal fields such as createdBy are not exposed.

import type { Guest, GuestItem } from "../types";

export function toGuest(item: GuestItem): Guest {
  return {
    eventId: item.eventId,
    guestId: item.guestId,
    firstName: item.firstName,
    lastName: item.lastName ?? null,
    email: item.email ?? null,
    group: item.group ?? null,
    plusOneAllowed: item.plusOneAllowed,
    mealChoice: item.mealChoice ?? null,
    dietaryNotes: item.dietaryNotes ?? null,
    rsvpStatus: item.rsvpStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
