// Signed, non-expiring share tokens for public event pages (no sign-in).
//
// Token: "<eventId>-" + base64url(HMAC-SHA256(secret, "eventwise-<purpose>:<eventId>"))
//
// This is the same format as galleryShare() in photo-service/photos.ts (purpose "gallery"),
// generalized with a purpose so a token for one page can never open another. Each feature
// also uses its own secret. Rotating a secret invalidates every link for that purpose.

import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_BYTES = 32;

const PURPOSE = /^[a-z]{1,32}$/;
const EVENT_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^([1-9][0-9]{0,19})-[A-Za-z0-9_-]{43}$/;

function checkInputs(purpose: string, secret: string): void {
  if (!PURPOSE.test(purpose)) throw new Error("Share purpose must be lowercase letters");
  if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) throw new Error("Share secret is missing or too short");
}

function signature(eventId: string, purpose: string, secret: string): string {
  return createHmac("sha256", secret).update(`eventwise-${purpose}:${eventId}`).digest("base64url");
}

/** The share token for one event and purpose. Throws on a bad event ID, purpose or secret. */
export function createEventShare(eventId: string, purpose: string, secret: string): string {
  checkInputs(purpose, secret);
  if (!EVENT_ID.test(eventId)) throw new Error("Invalid event ID for a share token");
  return `${eventId}-${signature(eventId, purpose, secret)}`;
}

/**
 * The event ID a token was issued for, or undefined when the token is malformed,
 * tampered with, or was issued for another purpose or secret. Constant-time compare.
 */
export function readEventShare(token: unknown, purpose: string, secret: string): string | undefined {
  checkInputs(purpose, secret);
  if (typeof token !== "string") return undefined;
  const match = TOKEN.exec(token);
  if (!match) return undefined;
  const expected = Buffer.from(`${match[1]}-${signature(match[1]!, purpose, secret)}`);
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? match[1] : undefined;
}
