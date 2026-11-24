// Request validation for the timeline API (Feature 13). Rules: docs/api/timeline.md, sections 3-4.
//
// Every invalid field is reported at once as 422 VALIDATION_ERROR with a `fields` map,
// the same envelope as the Expenses, Vendors and Guests APIs. Malformed path IDs are 400.

import { ApiError } from "../../expense-service/errors";
import { REMINDER_MINUTES, VISIBILITIES, type TimelineFields } from "../types";

export const LIMITS = { title: 120, place: 160, notes: 500, itemsPerEvent: 100 } as const;

const EDITABLE_FIELDS = new Set<string>([
  "title", "place", "notes", "startsAt", "endsAt", "visibility", "reminderMinutes",
]);
const PATCH_CONTROL_FIELDS = new Set<string>(["version", "notify"]);

/** Instants are only accepted between these years; anything else is almost certainly a typo. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

type FieldErrors = Record<string, string>;

export interface ValidatedPatch {
  changes: Partial<TimelineFields>;
  version: number;
  notify: boolean;
}

// --- Path parameters ----------------------------------------------------------

/** events.event_id: a positive decimal string without leading zeros (BIGINT kept as text). */
export function validEventId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}

/** itemId: a lowercase UUID, as produced by crypto.randomUUID(). */
export function validItemId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function requireEventId(value: unknown): string {
  if (!validEventId(value)) throw new ApiError(400, "BAD_REQUEST", "Invalid event ID.");
  return value;
}

export function requireItemId(value: unknown): string {
  if (!validItemId(value)) throw new ApiError(400, "BAD_REQUEST", "Invalid timeline item ID.");
  return value;
}

// --- Instants -----------------------------------------------------------------

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO 8601 instant with an explicit offset and whole minutes, and returns it
 * normalized to UTC ("2026-12-05T23:00:00Z"). Returns null for anything else: missing
 * offset, impossible dates, non-zero seconds, or years outside 2000-2100.
 */
export function parseInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "00", ms = "0", offset] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi);
  if (Number(s) !== 0 || Number(ms) !== 0) return null;
  if (year < MIN_YEAR || year > MAX_YEAR || hour > 23 || minute > 59) return null;

  // Reject impossible calendar dates such as 2026-02-30.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return null;
  }

  let offsetMinutes = 0;
  if (offset !== "Z") {
    const sign = offset!.startsWith("-") ? -1 : 1;
    const offsetHours = Number(offset!.slice(1, 3));
    const offsetMins = Number(offset!.slice(4, 6));
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = sign * (offsetHours * 60 + offsetMins);
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
  return toUtcInstant(new Date(utc));
}

/** "2026-12-05T23:00:00Z" for a Date; seconds are always ":00" because inputs have whole minutes. */
export function toUtcInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Throws 422 on endsAt when it is not after startsAt. Both must already be normalized. */
export function assertEndsAfterStart(startsAt: string, endsAt: string | null): void {
  if (endsAt !== null && endsAt <= startsAt) {
    throw new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", { endsAt: "Must be after the start time." });
  }
}

// --- Bodies -------------------------------------------------------------------

/** POST body: title and startsAt required; defaults visibility GUESTS and reminderMinutes 60. */
export function validateNewItem(body: unknown): TimelineFields {
  const input = requireObject(body);
  const errors: FieldErrors = {};
  rejectUnknownFields(input, EDITABLE_FIELDS, errors);

  if (!("title" in input)) errors.title = "Required.";
  if (!("startsAt" in input)) errors.startsAt = "Required.";

  const fields = readFields(input, errors);
  const result: TimelineFields = {
    title: fields.title ?? "",
    place: fields.place ?? null,
    notes: fields.notes ?? null,
    startsAt: fields.startsAt ?? "",
    endsAt: fields.endsAt ?? null,
    visibility: fields.visibility ?? "GUESTS",
    reminderMinutes: fields.reminderMinutes ?? 60,
  };
  if (!errors.startsAt && !errors.endsAt && result.endsAt !== null && result.endsAt <= result.startsAt) {
    errors.endsAt = "Must be after the start time.";
  }
  throwIfAny(errors);
  return result;
}

/**
 * PATCH body: the fields to change plus the `version` last read and an optional `notify` flag.
 * Cross-field rules that need the stored item (endsAt after startsAt) are checked by the service.
 */
export function validatePatch(body: unknown): ValidatedPatch {
  const input = requireObject(body);
  const errors: FieldErrors = {};
  rejectUnknownFields(input, new Set([...EDITABLE_FIELDS, ...PATCH_CONTROL_FIELDS]), errors);

  const version = input.version;
  if (version === undefined) errors.version = "Required. Send the version you last loaded.";
  else if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    errors.version = "Must be a positive whole number.";
  }

  const notify = input.notify;
  if (notify !== undefined && typeof notify !== "boolean") errors.notify = "Must be true or false.";

  const changes = readFields(input, errors);
  if (Object.keys(errors).length === 0 && Object.keys(changes).length === 0) {
    errors.body = "Include at least one field to change.";
  }
  throwIfAny(errors);
  return { changes, version: version as number, notify: notify === true };
}

/** PUT subscription body: exactly { idToken: "<JWT>" }. The token itself is verified elsewhere. */
export function validateSubscriptionBody(body: unknown): { idToken: string } {
  const input = requireObject(body);
  const errors: FieldErrors = {};
  rejectUnknownFields(input, new Set(["idToken"]), errors);
  const token = input.idToken;
  if (typeof token !== "string" || token.length === 0 || token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    errors.idToken = "Send the Cognito ID token of the signed-in user.";
  }
  throwIfAny(errors);
  return { idToken: token as string };
}

/** DELETE ?notify=true. Anything other than absent, "true" or "false" is 400. */
export function parseNotifyQuery(query: Record<string, string | undefined> | null | undefined): boolean {
  const keys = Object.keys(query ?? {});
  if (keys.some((key) => key !== "notify")) throw new ApiError(400, "BAD_REQUEST", "Unknown query parameter.");
  const value = query?.notify;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ApiError(400, "BAD_REQUEST", "notify must be true or false.");
}

// --- Helpers ------------------------------------------------------------------

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", { body: "Send a JSON object." });
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: Set<string>, errors: FieldErrors): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors[key] = "Unknown or read-only field.";
  }
}

function throwIfAny(errors: FieldErrors): void {
  if (Object.keys(errors).length > 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", errors);
  }
}

/** Validates and normalizes whichever editable fields are present. Absent fields stay absent. */
function readFields(input: Record<string, unknown>, errors: FieldErrors): Partial<TimelineFields> {
  const out: Partial<TimelineFields> = {};

  if ("title" in input) {
    const title = singleLineText(input.title, LIMITS.title, false);
    if (typeof title === "string") out.title = title;
    else errors.title = title?.error ?? "Required.";
  }
  if ("place" in input) {
    const place = singleLineText(input.place, LIMITS.place, true);
    if (typeof place === "string" || place === null) out.place = place;
    else errors.place = place.error;
  }
  if ("notes" in input) {
    const notes = multiLineText(input.notes, LIMITS.notes);
    if (typeof notes === "string" || notes === null) out.notes = notes;
    else errors.notes = notes.error;
  }
  if ("startsAt" in input) {
    const startsAt = parseInstant(input.startsAt);
    if (startsAt) out.startsAt = startsAt;
    else errors.startsAt = INSTANT_HINT;
  }
  if ("endsAt" in input) {
    if (input.endsAt === null) out.endsAt = null;
    else {
      const endsAt = parseInstant(input.endsAt);
      if (endsAt) out.endsAt = endsAt;
      else errors.endsAt = INSTANT_HINT;
    }
  }
  if ("visibility" in input) {
    if ((VISIBILITIES as readonly unknown[]).includes(input.visibility)) out.visibility = input.visibility as TimelineFields["visibility"];
    else errors.visibility = "Use GUESTS or TEAM.";
  }
  if ("reminderMinutes" in input) {
    if ((REMINDER_MINUTES as readonly unknown[]).includes(input.reminderMinutes)) {
      out.reminderMinutes = input.reminderMinutes as TimelineFields["reminderMinutes"];
    } else errors.reminderMinutes = "Use 0, 15, 60 or 1440.";
  }
  return out;
}

const INSTANT_HINT = "Use a date and time with a time zone and whole minutes, e.g. 2026-12-05T15:00:00-08:00.";

// Control characters other than tab are never allowed; titles and places must be one line.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** Returns trimmed text, null when cleared (only if nullable), or an error. */
function singleLineText(value: unknown, max: number, nullable: boolean): string | null | { error: string } {
  if (value === null) return nullable ? null : { error: "Required." };
  if (typeof value !== "string") return { error: "Must be text." };
  const text = value.trim();
  if (text === "") return nullable ? null : { error: "Required." };
  if (CONTROL.test(text) || LINE_BREAK.test(text)) return { error: "Must be a single line of text." };
  if ([...text].length > max) return { error: `Use ${max} characters or fewer.` };
  return text;
}

function multiLineText(value: unknown, max: number): string | null | { error: string } {
  if (value === null) return null;
  if (typeof value !== "string") return { error: "Must be text." };
  const text = value.trim().replace(/\r\n?/g, "\n");
  if (text === "") return null;
  if (CONTROL.test(text)) return { error: "Contains characters that are not allowed." };
  if ([...text].length > max) return { error: `Use ${max} characters or fewer.` };
  return text;
}
