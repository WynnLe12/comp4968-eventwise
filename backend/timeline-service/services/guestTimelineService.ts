// Guest access to the timeline (Feature 13, US41). Rules: docs/api/timeline.md, sections 4-5.
//
//   shareLink:     organizers get the event's guest URL (members only).
//   guestTimeline: anyone with a valid link sees the GUESTS activities, without signing in.
//
// Any invalid, tampered or other-purpose token, and any deleted event, is the same 404,
// so links cannot be probed.

import { ApiError } from "../../expense-service/errors";
import { requireMember as requireMemberInMySql } from "../../shared/auth/requireMember";
import { MIN_SECRET_BYTES, createEventShare, readEventShare } from "../../shared/auth/eventShare";
import { createEventSummaryLookup, type EventSummary, type EventSummaryLookup } from "../repositories/eventSummary";
import type { GuestTimelineItem } from "../types";
import { isGuestVisible, toGuestTimelineItem } from "./timelineMapper";
import type { MembershipCheck, TimelineStore } from "./timelineService";
import { requireEventId } from "./validation";

export const SHARE_PURPOSE = "timeline";

/** Missing or invalid deployment settings. The message names the variable, never its value. */
export class TimelineConfigurationError extends Error {
  override name = "TimelineConfigurationError";
}

export interface ShareLink {
  share: string;
  url: string;
}

export interface GuestTimeline {
  event: EventSummary;
  items: GuestTimelineItem[];
}

export interface GuestTimelineServiceOptions {
  repository: Pick<TimelineStore, "listItems">;
  requireMember?: MembershipCheck;
  events?: EventSummaryLookup;
  /** TIMELINE_SHARE_SECRET: at least 32 bytes. */
  secret?: string;
  /** GUEST_APP_ORIGIN: where the organizer app (and its /timeline/:share page) is served. */
  origin?: string;
}

const notFound = () => new ApiError(404, "NOT_FOUND", "This timeline link is not valid.");

export class GuestTimelineService {
  private readonly repository: Pick<TimelineStore, "listItems">;
  private readonly requireMember: MembershipCheck;
  private readonly events: EventSummaryLookup;
  private readonly secret: string | undefined;
  private readonly origin: string | undefined;

  constructor(options: GuestTimelineServiceOptions) {
    this.repository = options.repository;
    this.requireMember = options.requireMember ?? requireMemberInMySql;
    this.events = options.events ?? createEventSummaryLookup();
    this.secret = options.secret;
    this.origin = options.origin;
  }

  async shareLink(rawEventId: unknown, sub: string): Promise<ShareLink> {
    const eventId = requireEventId(rawEventId);
    await this.requireMember(eventId, sub);
    const share = createEventShare(eventId, SHARE_PURPOSE, this.requireSecret());
    return { share, url: guestTimelineUrl(this.requireOrigin(), share) };
  }

  async guestTimeline(token: unknown): Promise<GuestTimeline> {
    const eventId = readEventShare(token, SHARE_PURPOSE, this.requireSecret());
    if (!eventId) throw notFound();
    // A link to a deleted event looks exactly like a bad link.
    const event = await this.events(eventId);
    if (!event) throw notFound();
    const records = await this.repository.listItems(eventId);
    return { event, items: records.filter(isGuestVisible).map(toGuestTimelineItem) };
  }

  private requireSecret(): string {
    if (!this.secret || Buffer.byteLength(this.secret) < MIN_SECRET_BYTES) {
      throw new TimelineConfigurationError(`TIMELINE_SHARE_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    return this.secret;
  }

  private requireOrigin(): string {
    const origin = this.origin && parseAppOrigin(this.origin);
    if (!origin) {
      throw new TimelineConfigurationError("GUEST_APP_ORIGIN must be an https origin, or http://localhost for development");
    }
    return origin;
  }
}

/**
 * Accepts "https://host[:port]" or "http://localhost[:port]" / "http://127.0.0.1[:port]",
 * with nothing after the host, and returns it normalized. Anything else returns undefined.
 */
export function parseAppOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  if (value.trim().replace(/\/$/, "") !== url.origin) return undefined;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.origin;
  return undefined;
}

/** The guest page URL for a share token, e.g. https://main.example.amplifyapp.com/timeline/42-abc… */
export function guestTimelineUrl(origin: string, share: string): string {
  return `${origin}/timeline/${encodeURIComponent(share)}`;
}
