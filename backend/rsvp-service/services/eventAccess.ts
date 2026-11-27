// Membership check for organizer routes (Feature 8).
//
// The RSVP Lambdas run outside the VPC (they call Step Functions, which the VPC can't
// reach without a NAT gateway), so they can't query MySQL. Instead they forward the
// organizer's own access token to the Event API: GET /events/{eventId} answers 200 only
// for members of that event, and its body has the event name, date and venue the
// invitations need. The guest Lambda uses the same check.

import { ApiError } from "../../expense-service/errors";
import { RsvpConfigurationError } from "../rsvpLink";
import type { EventSnapshot } from "../types";

export type EventAccess = (eventId: string, authorization: string | undefined) => Promise<EventSnapshot>;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createEventAccess(
  apiUrl: string | undefined,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): EventAccess {
  return async (eventId, authorization) => {
    const base = apiUrl?.trim().replace(/\/$/, "");
    if (!base || !/^https:\/\//.test(base)) {
      throw new RsvpConfigurationError("EVENT_API_URL must be the Event API's https invoke URL");
    }
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }

    let response: Awaited<ReturnType<Fetch>>;
    try {
      response = await fetchImpl(`${base}/events/${encodeURIComponent(eventId)}`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      console.error(`Event API call failed: ${error instanceof Error ? error.name : "unknown error"}`);
      throw new ApiError(502, "UPSTREAM_ERROR", "We couldn't check your access to this event. Please try again.");
    }
    if (response.status === 401) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (response.status === 403 || response.status === 404) {
      throw new ApiError(403, "FORBIDDEN", "You don't have access to this event.");
    }
    if (!response.ok) {
      console.error(`Event API answered ${response.status}`);
      throw new ApiError(502, "UPSTREAM_ERROR", "We couldn't check your access to this event. Please try again.");
    }

    const event = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!event || event.event_id !== eventId || typeof event.name !== "string") {
      throw new ApiError(502, "UPSTREAM_ERROR", "We couldn't read this event. Please try again.");
    }
    const date = nullableText(event.event_date);
    return {
      eventName: event.name,
      eventDate: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
      venue: nullableText(event.venue),
    };
  };
}
