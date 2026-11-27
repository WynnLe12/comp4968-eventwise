// Pure helpers for the Timeline page (Feature 13): time-zone conversion, grouping,
// form validation and PATCH diffs. No runtime imports, so scripts/timeline.test.mjs can
// load this file directly. API contract: docs/api/timeline.md.
//
// The API stores UTC instants; the UI always shows and edits event times in Vancouver time.

export const TIME_ZONE = "America/Vancouver";

export type Visibility = "GUESTS" | "TEAM";
export type ReminderMinutes = 0 | 15 | 60 | 1440;

export interface TimelineItem {
  eventId: string;
  itemId: string;
  title: string;
  place: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string | null;
  visibility: Visibility;
  reminderMinutes: ReminderMinutes;
  reminderAt: string | null;
  reminderSent: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationResult {
  status: "NOT_REQUESTED" | "NO_CHANGE" | "NO_RECIPIENTS" | "QUEUED" | "FAILED";
  recipients: number;
}

/** What the activity form edits. All strings, exactly as typed. */
export interface TimelineForm {
  title: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM, 24-hour (native time input)
  endTime: string; // HH:MM or ""
  place: string;
  notes: string;
  visibility: Visibility;
  reminderMinutes: string; // "0" | "15" | "60" | "1440"
}

export type FormErrors = Partial<Record<keyof TimelineForm | "form", string>>;

/** Request fields for POST, or the candidate values for a PATCH. */
export interface TimelineFields {
  title: string;
  place: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string | null;
  visibility: Visibility;
  reminderMinutes: ReminderMinutes;
}

export const LIMITS = { title: 120, place: 160, notes: 500 } as const;

export const REMINDER_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "No reminder" },
  { value: "15", label: "15 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
];

export const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: "GUESTS", label: "Guests and planning team" },
  { value: "TEAM", label: "Planning team only" },
];

// --- Time zone ---------------------------------------------------------------------

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }

function localParts(ms: number): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute! };
}

/** Minutes the zone is ahead of UTC at an instant (Vancouver: -480 or -420). */
function offsetMinutes(ms: number): number {
  const p = localParts(ms);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

/**
 * "2026-12-05" + "15:00" in Vancouver -> "2026-12-05T15:00:00-08:00".
 * Returns null for malformed input and for clock times skipped by a DST change.
 */
export function localToInstant(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [year, month, day, hour, minute] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (hour > 23 || minute > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall - offsetMinutes(wall) * 60_000;
  utc = wall - offsetMinutes(utc) * 60_000;
  const check = localParts(utc);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) {
    return null;
  }
  const offset = offsetMinutes(utc);
  const sign = offset < 0 ? "-" : "+";
  return `${d[1]}-${d[2]}-${d[3]}T${t[1]}:${t[2]}:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** Today's date in Vancouver, "YYYY-MM-DD" (the earliest date the activity form offers). */
export function todayInVancouver(now: Date = new Date()): string {
  const p = localParts(now.getTime());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC instant -> { date: "YYYY-MM-DD", time: "HH:MM" } in Vancouver. */
export function instantToLocal(instant: string): { date: string; time: string } {
  const p = localParts(Date.parse(instant));
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });

/** "3:00 PM" in Vancouver. */
export function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant));
}

/** "Saturday, December 5, 2026" for a local "YYYY-MM-DD". */
export function formatDay(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/** The calendar card at the top: SATURDAY / 5 / December 2026. Null when there is no event date. */
export function dateBadge(localDate: string | null): { weekday: string; day: string; monthYear: string } | null {
  if (!localDate || !/^\d{4}-\d{2}-\d{2}/.test(localDate)) return null;
  const [year, month, day] = localDate.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(date);
  return {
    weekday: format({ weekday: "long" }).toUpperCase(),
    day: String(day),
    monthYear: format({ month: "long", year: "numeric" }),
  };
}

/** "3:00 PM – 3:30 PM", or just the start time. */
export function formatRange(item: Pick<TimelineItem, "startsAt" | "endsAt">): string {
  return item.endsAt ? `${formatTime(item.startsAt)} – ${formatTime(item.endsAt)}` : formatTime(item.startsAt);
}

// --- Grouping ------------------------------------------------------------------------

export interface DayGroup<T> { date: string; label: string; items: T[] }

/** Items grouped by their Vancouver calendar day, in time order whatever order they arrive in. */
export function groupByDay<T extends Pick<TimelineItem, "startsAt">>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  // Stable sort: equal start times keep the API's tie order (title, then ID).
  const ordered = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const item of ordered) {
    const { date } = instantToLocal(item.startsAt);
    let group = groups.at(-1);
    if (!group || group.date !== date) {
      group = { date, label: formatDay(date), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** The soonest activity that has not started yet, for the highlighted dot. Order-independent. */
export function nextUpItemId(items: Pick<TimelineItem, "itemId" | "startsAt">[], now: Date): string | null {
  let next: { itemId: string; at: number } | null = null;
  for (const item of items) {
    const at = Date.parse(item.startsAt);
    if (at >= now.getTime() && (!next || at < next.at)) next = { itemId: item.itemId, at };
  }
  return next?.itemId ?? null;
}

export function reminderLabel(minutes: ReminderMinutes): string {
  return REMINDER_OPTIONS.find((option) => option.value === String(minutes))?.label ?? "No reminder";
}

// --- Form ----------------------------------------------------------------------------

export function emptyForm(eventDate: string | null): TimelineForm {
  return {
    title: "", date: eventDate?.slice(0, 10) ?? "", startTime: "", endTime: "", place: "", notes: "",
    visibility: "GUESTS", reminderMinutes: "60",
  };
}

export function formFromItem(item: TimelineItem): TimelineForm {
  const start = instantToLocal(item.startsAt);
  return {
    title: item.title,
    date: start.date,
    startTime: start.time,
    endTime: item.endsAt ? instantToLocal(item.endsAt).time : "",
    place: item.place ?? "",
    notes: item.notes ?? "",
    visibility: item.visibility,
    reminderMinutes: String(item.reminderMinutes),
  };
}

const length = (text: string) => [...text].length;

export interface ValidateOptions {
  /** Defaults to the current time. */
  now?: Date;
  /** The stored activity when editing: only times that change must be in the future. */
  item?: Pick<TimelineItem, "startsAt" | "endsAt"> | null;
}

/**
 * Checks the form the same way the API will, so most mistakes show before saving.
 * An end time earlier than the start time means the activity runs past midnight.
 * Times can't be in the past (like the RSVP deadline), but an activity that is already
 * over can still be edited as long as its times are left unchanged.
 */
export function validateForm(form: TimelineForm, options: ValidateOptions = {}): { errors: FormErrors; fields?: TimelineFields } {
  const now = options.now ?? new Date();
  const item = options.item ?? null;
  const errors: FormErrors = {};
  const title = form.title.trim();
  const place = form.place.trim();
  const notes = form.notes.trim();

  if (!title) errors.title = "Enter a name for this activity.";
  else if (length(title) > LIMITS.title) errors.title = `Use ${LIMITS.title} characters or fewer.`;
  if (length(place) > LIMITS.place) errors.place = `Use ${LIMITS.place} characters or fewer.`;
  if (length(notes) > LIMITS.notes) errors.notes = `Use ${LIMITS.notes} characters or fewer.`;
  if (!form.date) errors.date = "Choose a date.";
  if (!form.startTime) errors.startTime = "Choose a start time.";

  let startsAt: string | null = null;
  let endsAt: string | null = null;
  if (form.date && form.startTime) {
    startsAt = localToInstant(form.date, form.startTime);
    if (!startsAt) errors.startTime = "That time doesn't exist on this date (clocks change). Choose another.";
  }
  if (startsAt && form.endTime) {
    endsAt = localToInstant(form.date, form.endTime);
    if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      endsAt = localToInstant(nextDay(form.date), form.endTime);
    }
    if (!endsAt) errors.endTime = "That time doesn't exist on this date (clocks change). Choose another.";
    else if (Date.parse(endsAt) === Date.parse(startsAt)) errors.endTime = "End time must be after the start time.";
  }
  if (startsAt && !errors.startTime && !sameInstant(startsAt, item?.startsAt ?? null) && Date.parse(startsAt) <= now.getTime()) {
    errors.startTime = "The start time must be in the future.";
  }
  if (endsAt && !errors.endTime && !sameInstant(endsAt, item?.endsAt ?? null) && Date.parse(endsAt) <= now.getTime()) {
    errors.endTime = "The end time must be in the future.";
  }
  if (!["0", "15", "60", "1440"].includes(form.reminderMinutes)) errors.reminderMinutes = "Choose a reminder.";

  if (Object.keys(errors).length > 0 || !startsAt) return { errors };
  return {
    errors,
    fields: {
      title,
      place: place || null,
      notes: notes || null,
      startsAt,
      endsAt,
      visibility: form.visibility,
      reminderMinutes: Number(form.reminderMinutes) as ReminderMinutes,
    },
  };
}

function nextDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

const sameInstant = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

/** Only the fields that differ from the stored item, for a minimal PATCH. */
export function changedFields(item: TimelineItem, fields: TimelineFields): Partial<TimelineFields> {
  const changes: Partial<TimelineFields> = {};
  if (fields.title !== item.title) changes.title = fields.title;
  if (fields.place !== item.place) changes.place = fields.place;
  if (fields.notes !== item.notes) changes.notes = fields.notes;
  if (!sameInstant(fields.startsAt, item.startsAt)) changes.startsAt = fields.startsAt;
  if (!sameInstant(fields.endsAt, item.endsAt)) changes.endsAt = fields.endsAt;
  if (fields.visibility !== item.visibility) changes.visibility = fields.visibility;
  if (fields.reminderMinutes !== item.reminderMinutes) changes.reminderMinutes = fields.reminderMinutes;
  return changes;
}

/** True when a change would trigger an email if "notify" is ticked (docs/api/timeline.md §7). */
export function isNotifiableChange(changes: Partial<TimelineFields>): boolean {
  return ["title", "place", "startsAt", "endsAt", "visibility"].some((field) => field in changes);
}

/** Maps API 422 field names to the form inputs that show them. */
export function formErrorsFromApi(fields: Record<string, string> | undefined): FormErrors {
  const map: Record<string, keyof TimelineForm | "form"> = {
    title: "title", place: "place", notes: "notes", startsAt: "startTime", endsAt: "endTime",
    visibility: "visibility", reminderMinutes: "reminderMinutes",
  };
  const errors: FormErrors = {};
  for (const [field, message] of Object.entries(fields ?? {})) {
    const target = map[field] ?? "form";
    errors[target] = errors[target] ?? message;
  }
  return errors;
}

/** Toast text after a save or delete, depending on what happened to the emails. */
export function savedMessage(action: "Saved" | "Deleted", notification?: NotificationResult): string {
  switch (notification?.status) {
    case "QUEUED":
      return `${action}. Emailing ${notification.recipients} ${notification.recipients === 1 ? "person" : "people"} about the change.`;
    case "NO_RECIPIENTS":
      return `${action}. Nobody affected has an email address yet.`;
    case "NO_CHANGE":
      return `${action}. Nothing guests need to hear about changed, so no email was sent.`;
    case "FAILED":
      return `${action}, but the update emails couldn't be sent.`;
    default:
      return `${action}.`;
  }
}
