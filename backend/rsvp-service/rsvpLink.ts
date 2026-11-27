// Private, per-guest RSVP links (Feature 8). No sign-in: the token in the URL is the credential.
//
// Token: "<eventId>.<guestId>." + base64url(HMAC-SHA256(secret, "eventwise-rsvp:<eventId>:<guestId>"))
//
// The signature covers both IDs, so a guest's link can only read or change that one guest
// in that one event; changing either ID breaks the signature. Nothing is stored per link,
// so no index is needed: the IDs in the token are the table key. A deleted guest's link
// stops working because the guest lookup fails. Rotating RSVP_LINK_SECRET breaks every link.

import { createHmac, timingSafeEqual } from "node:crypto";
import { MIN_SECRET_BYTES } from "../shared/auth/eventShare";
import type { GuestKey } from "./types";

export type { GuestKey };

const EVENT_ID = /^[1-9][0-9]{0,19}$/;
/** UUIDs from the app, plus the short test IDs already in the staging table. */
const GUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^([1-9][0-9]{0,19})\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;

export class RsvpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RsvpConfigurationError";
  }
}

export function requireSecret(secret: string | undefined): string {
  if (!secret || Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new RsvpConfigurationError(`RSVP_LINK_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return secret;
}

function signature(eventId: string, guestId: string, secret: string): string {
  return createHmac("sha256", secret).update(`eventwise-rsvp:${eventId}:${guestId}`).digest("base64url");
}

/** The RSVP token for one guest. Throws on bad IDs or a missing/short secret. */
export function createRsvpToken(key: GuestKey, secret: string | undefined): string {
  const checked = requireSecret(secret);
  if (!EVENT_ID.test(key.eventId) || !GUEST_ID.test(key.guestId)) {
    throw new Error("Invalid event or guest ID for an RSVP token");
  }
  return `${key.eventId}.${key.guestId}.${signature(key.eventId, key.guestId, checked)}`;
}

/** The guest a token was issued for, or undefined if it is malformed or tampered with. Constant-time compare. */
export function readRsvpToken(token: unknown, secret: string | undefined): GuestKey | undefined {
  const checked = requireSecret(secret);
  if (typeof token !== "string") return undefined;
  const match = TOKEN.exec(token);
  if (!match) return undefined;
  const [, eventId, guestId] = match as unknown as [string, string, string];
  const expected = Buffer.from(`${eventId}.${guestId}.${signature(eventId, guestId, checked)}`);
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  return { eventId, guestId };
}

/**
 * Accepts "https://host[:port]" or "http://localhost[:port]" / "http://127.0.0.1[:port]"
 * (nothing after the host) and returns it normalized; anything else returns undefined.
 * Same rule as the timeline's GUEST_APP_ORIGIN.
 */
export function parseAppOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
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

export interface LinkSettings {
  /** GUEST_APP_ORIGIN: where the organizer app (and its /rsvp/:token page) is served. */
  origin?: string;
  /** RSVP_LINK_SECRET */
  secret?: string;
}

/** The guest's RSVP page URL, e.g. https://main.example.amplifyapp.com/rsvp/42.<guestId>.<sig> */
export function rsvpUrl(key: GuestKey, settings: LinkSettings): string {
  const origin = parseAppOrigin(settings.origin);
  if (!origin) {
    throw new RsvpConfigurationError("GUEST_APP_ORIGIN must be an https origin, or http://localhost for development");
  }
  return `${origin}/rsvp/${encodeURIComponent(createRsvpToken(key, settings.secret))}`;
}
