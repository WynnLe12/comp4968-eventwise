// Turns an RSVP email message from SQS into a subject, plain-text body and HTML body (Feature 8).
// Pure functions: no AWS calls. The deadline is shown in Vancouver time, like the app.

import { EVENT_TIME_ZONE } from "../services/validation";
import type { RsvpEmailMessage } from "./messages";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// --- Validation of queue messages ------------------------------------------------------

const TYPES = new Set(["RSVP_INVITATION", "RSVP_REMINDER"]);

const isText = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
const isOptionalText = (value: unknown, max: number) => value === null || isText(value, max);

function isLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    return (url.protocol === "https:" || local) && url.pathname.startsWith("/rsvp/");
  } catch {
    return false;
  }
}

/** Parses an SQS body into a message, or returns null if it doesn't match the contract. */
export function parseEmailMessage(body: string): RsvpEmailMessage | null {
  let value: RsvpEmailMessage;
  try {
    value = JSON.parse(body) as RsvpEmailMessage;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !TYPES.has(value.type)) return null;
  if (typeof value.to !== "string" || value.to.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(value.to)) return null;
  if (!isText(value.eventName, 200) || !isOptionalText(value.guestName, 210) || !isOptionalText(value.venue, 255)) return null;
  if (!(value.eventDate === null || (typeof value.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.eventDate)))) return null;
  if (!(value.startTime === null || (typeof value.startTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime)))) return null;
  if (typeof value.deadline !== "string" || Number.isNaN(Date.parse(value.deadline))) return null;
  if (!isOptionalText(value.message, 1000) || !isLink(value.rsvpUrl)) return null;
  return value;
}

// --- Formatting -------------------------------------------------------------------------

/** "Saturday, September 20, 2025" from "2025-09-20" (a calendar date, so no time zone shift). */
export function formatEventDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

/** "4:00 PM" from "16:00". */
export function formatStartTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** "Friday, August 15 at 11:59 PM" in Vancouver time. */
export function formatDeadline(instant: string): string {
  const date = new Date(instant);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: EVENT_TIME_ZONE, weekday: "long", month: "long", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: EVENT_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} at ${time}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- Content ----------------------------------------------------------------------------

export function renderEmail(message: RsvpEmailMessage): EmailContent {
  const reminder = message.type === "RSVP_REMINDER";
  const greeting = message.guestName ? `Hi ${message.guestName},` : "Hello,";
  const deadline = formatDeadline(message.deadline);

  const subject = reminder
    ? `Reminder: please RSVP by ${deadline} · ${message.eventName}`
    : `You're invited: ${message.eventName}`;
  const lead = reminder
    ? `We haven't received your RSVP for ${message.eventName} yet. Please let the hosts know whether you can make it.`
    : `You're invited to ${message.eventName}. Please let the hosts know whether you can make it.`;

  const details: string[] = [];
  if (message.eventDate) {
    details.push(`When: ${formatEventDate(message.eventDate)}${message.startTime ? ` at ${formatStartTime(message.startTime)}` : ""}`);
  } else if (message.startTime) {
    details.push(`Starts at: ${formatStartTime(message.startTime)}`);
  }
  if (message.venue) details.push(`Where: ${message.venue}`);
  details.push(`Please reply by: ${deadline} (Vancouver time)`);

  const footer = "This link is just for you. Please don't forward it: anyone with it can change your RSVP.";

  const text = [
    greeting,
    "",
    lead,
    "",
    ...details,
    ...(message.message ? ["", "A note from the hosts:", message.message] : []),
    "",
    `RSVP here: ${message.rsvpUrl}`,
    "",
    footer,
  ].join("\n");

  const detailRows = details
    .map((line) => {
      const [label, ...rest] = line.split(": ");
      return `<tr><td style="padding:4px 12px 4px 0;color:#6f697c;white-space:nowrap;vertical-align:top">${escapeHtml(label!)}</td>` +
        `<td style="padding:4px 0;font-weight:bold">${escapeHtml(rest.join(": "))}</td></tr>`;
    })
    .join("");
  const note = message.message
    ? `<div style="margin:20px 0;padding:14px 16px;background:#f6f2ff;border-radius:10px">` +
      `<div style="font-size:12px;color:#6f697c;margin-bottom:6px">A note from the hosts</div>` +
      `<div style="white-space:pre-line">${escapeHtml(message.message)}</div></div>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fbf8f3;font-family:Arial,Helvetica,sans-serif;color:#25213a">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 6px;color:#7958e8;font-size:12px;letter-spacing:1px;text-transform:uppercase">${reminder ? "RSVP reminder" : "You're invited"}</p>
<h1 style="margin:0 0 18px;font-size:22px">${escapeHtml(message.eventName)}</h1>
<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(lead)}</p>
<table style="border-collapse:collapse;font-size:14px">${detailRows}</table>
${note}
<p style="margin:24px 0"><a href="${escapeHtml(message.rsvpUrl)}" style="display:inline-block;background:#7958e8;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:bold">RSVP now</a></p>
<p style="margin:0;color:#6f697c;font-size:12px;line-height:1.5">${escapeHtml(footer)}</p>
</div></body></html>`;

  return { subject, text, html };
}
