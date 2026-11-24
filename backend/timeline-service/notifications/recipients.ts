// Who gets a timeline email (Feature 13). Rules: docs/api/timeline.md §7.
//
//   TEAM activity    -> subscribed organizers
//   GUESTS activity  -> subscribed organizers + guests with an email who haven't declined
//
// Subscribers are re-checked against event_members on every send, so a removed co-planner
// stops getting emails even though their subscription row remains. Addresses are compared
// case-insensitively; someone who is both an organizer and a guest gets one email, as an organizer.

import type { RowDataPacket } from "mysql2/promise";
import { GuestRepository } from "../../guest-service/repositories/guestRepository";
import { getDatabasePool } from "../../shared/db/pool";
import type { TimelineRepository } from "../repositories/timelineRepository";
import type { Visibility } from "../types";

export type Audience = "ORGANIZER" | "GUEST";

export interface Recipient {
  email: string;
  audience: Audience;
}

/** Cognito subs of everyone who is currently an OWNER or CO_PLANNER of the event. */
export type MemberSubsLookup = (eventId: string) => Promise<Set<string>>;

/** Guests of the event as stored by the guest service. */
export type GuestLookup = (eventId: string) => Promise<{ email?: string; rsvpStatus: string }[]>;

/** Protects Lambda time and the SES quota if a guest list is unexpectedly large. */
export const MAX_RECIPIENTS = 500;

type Execute = (sql: string, values: unknown[]) => Promise<[RowDataPacket[], unknown]>;

export function createMemberSubsLookup(
  execute: Execute = (sql, values) => getDatabasePool().execute<RowDataPacket[]>(sql, values as never),
): MemberSubsLookup {
  return async (eventId) => {
    const [rows] = await execute("SELECT cognito_sub FROM event_members WHERE event_id = ?", [eventId]);
    return new Set(rows.map((row) => String(row.cognito_sub)));
  };
}

export function createGuestLookup(repository = new GuestRepository()): GuestLookup {
  return (eventId) => repository.listByEvent(eventId);
}

export interface RecipientResolverOptions {
  subscribers: Pick<TimelineRepository, "listSubscribers">;
  members?: MemberSubsLookup;
  guests?: GuestLookup;
}

export class RecipientResolver {
  private readonly subscribers: Pick<TimelineRepository, "listSubscribers">;
  private readonly members: MemberSubsLookup;
  private readonly guests: GuestLookup;

  constructor(options: RecipientResolverOptions) {
    this.subscribers = options.subscribers;
    this.members = options.members ?? createMemberSubsLookup();
    this.guests = options.guests ?? createGuestLookup();
  }

  /**
   * Everyone affected by an activity that is (or was) visible to the given audiences.
   * Pass both visibilities when an edit moved an activity between TEAM and GUESTS.
   */
  async resolve(eventId: string, visibilities: ReadonlySet<Visibility>): Promise<{ recipients: Recipient[]; truncated: boolean }> {
    const includeGuests = visibilities.has("GUESTS");
    const [subscribers, members, guests] = await Promise.all([
      this.subscribers.listSubscribers(eventId),
      this.members(eventId),
      includeGuests ? this.guests(eventId) : Promise.resolve([]),
    ]);

    const byEmail = new Map<string, Recipient>();
    for (const subscriber of subscribers) {
      if (!members.has(subscriber.sub)) continue;
      const email = normalizeEmail(subscriber.email);
      if (email) byEmail.set(email, { email, audience: "ORGANIZER" });
    }
    for (const guest of guests) {
      if (guest.rsvpStatus === "DECLINED") continue;
      const email = normalizeEmail(guest.email);
      if (email && !byEmail.has(email)) byEmail.set(email, { email, audience: "GUEST" });
    }

    const all = [...byEmail.values()];
    return { recipients: all.slice(0, MAX_RECIPIENTS), truncated: all.length > MAX_RECIPIENTS };
  }
}

function normalizeEmail(value: string | undefined | null): string | null {
  const email = value?.trim().toLowerCase();
  return email && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email) && email.length <= 254 ? email : null;
}
