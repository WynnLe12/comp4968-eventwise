// Turns a timeline email message from SQS into the subject, plain-text and HTML body (Feature 13).
// Pure functions: no AWS calls. Times are shown in Vancouver time, like the app.

import type { EmailItem, TimelineEmailMessage } from "./messages";

export const EMAIL_TIME_ZONE = "America/Vancouver";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// --- Validation of queue messages ------------------------------------------------------

const AUDIENCES = new Set(["GUEST", "ORGANIZER"]);
const FIELDS = new Set(["title", "place", "notes", "startsAt", "endsAt", "visibility", "reminderMinutes"]);

function isInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isItem(value: unknown): value is EmailItem {
  const item = value as EmailItem | null;
  return Boolean(item) && typeof item!.title === "string" && item!.title.length > 0 && item!.title.length <= 200 &&
    (item!.place === null || (typeof item!.place === "string" && item!.place.length <= 200)) &&
    isInstant(item!.startsAt) && (item!.endsAt === null || isInstant(item!.endsAt));
}

function isLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

/** Parses an SQS body into a message, or returns null if it does not match the contract. */
export function parseEmailMessage(body: string): TimelineEmailMessage | null {
  let value: TimelineEmailMessage;
  try {
    value = JSON.parse(body) as TimelineEmailMessage;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (typeof value.to !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(value.to) || value.to.length > 254) return null;
  if (!AUDIENCES.has(value.audience)) return null;
  if (typeof value.eventName !== "string" || !value.eventName || value.eventName.length > 200) return null;
  if (!isItem(value.item) || !isLink(value.timelineUrl)) return null;
  if (value.type === "TIMELINE_REMINDER") return value;
  if (value.type !== "TIMELINE_CHANGED") return null;
  if (value.change === "DELETED") return value;
  if (value.change !== "UPDATED" || !isItem(value.previous)) return null;
  if (!Array.isArray(value.changedFields) || !value.changedFields.every((field) => FIELDS.has(field))) return null;
  return value;
}

// --- Formatting -------------------------------------------------------------------------

const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: EMAIL_TIME_ZONE, weekday: "long", month: "long", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: EMAIL_TIME_ZONE, hour: "numeric", minute: "2-digit" });
const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: EMAIL_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export const formatTime = (instant: string) => timeFormat.format(new Date(instant));
export const formatDay = (instant: string) => dayFormat.format(new Date(instant));

/** "Saturday, December 5, 3:00 PM – 3:30 PM", adding the end day when it is a different day. */
export function formatWhen(item: Pick<EmailItem, "startsAt" | "endsAt">): string {
  const start = `${formatDay(item.startsAt)}, ${formatTime(item.startsAt)}`;
  if (!item.endsAt) return start;
  const sameDay = localDate.format(new Date(item.startsAt)) === localDate.format(new Date(item.endsAt));
  return `${start} – ${sameDay ? "" : `${formatDay(item.endsAt)}, `}${formatTime(item.endsAt)}`;
}

/** "3:00 PM" or "3:00 PM – 3:30 PM" without the day. */
function formatClock(item: Pick<EmailItem, "startsAt" | "endsAt">): string {
  return item.endsAt ? `${formatTime(item.startsAt)} – ${formatTime(item.endsAt)}` : formatTime(item.startsAt);
}

/** Lines describing what changed, e.g. "Time: Sat… 3:00 PM → Sat… 3:30 PM". */
export function describeChanges(message: TimelineEmailMessage): string[] {
  const before = message.previous!;
  const after = message.item;
  const fields = new Set(message.changedFields ?? []);
  const lines: string[] = [];
  if (fields.has("title")) lines.push(`Name: “${before.title}” → “${after.title}”`);
  if (fields.has("startsAt") || fields.has("endsAt")) {
    // Same day before and after: show the date once ("Saturday, December 5: 3:00 PM → 3:30 PM").
    const instants = [before.startsAt, before.endsAt, after.startsAt, after.endsAt].filter((v): v is string => v !== null);
    const sameDay = new Set(instants.map((v) => localDate.format(new Date(v)))).size === 1;
    lines.push(sameDay
      ? `Time: ${formatDay(after.startsAt)}: ${formatClock(before)} → ${formatClock(after)}`
      : `Time: ${formatWhen(before)} → ${formatWhen(after)}`);
  }
  if (fields.has("place")) lines.push(`Place: ${before.place ?? "not set"} → ${after.place ?? "not set"}`);
  if (fields.has("visibility")) {
    lines.push(message.audience === "GUEST"
      ? "This activity is no longer part of the guest schedule."
      : "Who can see this activity changed.");
  }
  return lines;
}

// --- Content ----------------------------------------------------------------------------

export function renderEmail(message: TimelineEmailMessage): EmailContent {
  const { item, eventName } = message;
  const when = formatWhen(item);
  const where = item.place ? ` at ${item.place}` : "";

  let subject: string;
  let lead: string;
  let details: string[];

  if (message.type === "TIMELINE_REMINDER") {
    subject = `Reminder: ${item.title} at ${formatTime(item.startsAt)} · ${eventName}`;
    lead = `${item.title} starts soon.`;
    details = [`When: ${when}`, ...(item.place ? [`Where: ${item.place}`] : [])];
  } else if (message.change === "DELETED") {
    subject = `Removed from the schedule: ${item.title} · ${eventName}`;
    lead = `${item.title} (${when}${where}) has been removed from the schedule.`;
    details = [];
  } else {
    subject = `Schedule update: ${item.title} · ${eventName}`;
    lead = `${item.title} has changed.`;
    details = [...describeChanges(message), `Now: ${when}${where}`];
  }

  const linkLabel = message.audience === "GUEST" ? "See the full schedule" : "Open the timeline";
  const footer = message.audience === "GUEST"
    ? `You're receiving this because you're on the guest list for ${eventName}.`
    : "You're receiving this because you turned on timeline emails in EventWise. You can turn them off on the Timeline page.";

  const text = [
    eventName,
    "",
    lead,
    ...(details.length ? ["", ...details] : []),
    "",
    `${linkLabel}: ${message.timelineUrl}`,
    "",
    "Times are in Vancouver time.",
    footer,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fbf8f3;font-family:Arial,Helvetica,sans-serif;color:#25213a">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#7b5cd6">${escapeHtml(eventName)}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(lead)}</h1>
${details.map((line) => `<p style="margin:0 0 8px;font-size:15px;line-height:1.5">${escapeHtml(line)}</p>`).join("\n")}
<p style="margin:22px 0"><a href="${escapeHtml(message.timelineUrl)}" style="display:inline-block;background:#7b5cd6;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:bold">${linkLabel}</a></p>
<p style="margin:0;font-size:12px;color:#6f6a80">Times are in Vancouver time. ${escapeHtml(footer)}</p>
</div></body></html>`;

  return { subject: oneLine(subject).slice(0, 200), text, html };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
