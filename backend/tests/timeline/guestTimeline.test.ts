// Share tokens, the guest timeline service and the event summary lookup
// (no AWS, Docker or MySQL needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiError } from "../../expense-service/errors";
import { galleryShare } from "../../photo-service/photos";
import { createEventShare, readEventShare } from "../../shared/auth/eventShare";
import { createEventSummaryLookup } from "../../timeline-service/repositories/eventSummary";
import {
  GuestTimelineService,
  TimelineConfigurationError,
  guestTimelineUrl,
  parseAppOrigin,
} from "../../timeline-service/services/guestTimelineService";
import { MemoryTimelineStore, memberships } from "./fakes";

const SECRET = "timeline-secret-0123456789abcdef-xyz";
const OTHER_SECRET = "another-secret-0123456789abcdef-xyz";
const ORIGIN = "https://main.d220ourpslhwbp.amplifyapp.com";

// --- Share tokens ---------------------------------------------------------------

test("a share token round-trips to its event and is bound to purpose and secret", () => {
  const token = createEventShare("42", "timeline", SECRET);
  assert.match(token, /^42-[A-Za-z0-9_-]{43}$/);
  assert.equal(readEventShare(token, "timeline", SECRET), "42");
  assert.equal(readEventShare(token, "gallery", SECRET), undefined);
  assert.equal(readEventShare(token, "timeline", OTHER_SECRET), undefined);
});

test("tampered, re-targeted and malformed tokens are rejected", () => {
  const token = createEventShare("42", "timeline", SECRET);
  const signature = token.slice(3);
  const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  for (const bad of [
    `42-${flipped}`, // tampered signature
    `43-${signature}`, // another event with this event's signature
    `042-${signature}`,
    token.slice(0, -1),
    `${token}=`,
    "",
    42,
    null,
  ]) {
    assert.equal(readEventShare(bad, "timeline", SECRET), undefined, String(bad));
  }
});

test("the token format matches galleryShare, so a gallery link can never open the timeline", () => {
  assert.equal(createEventShare("42", "gallery", SECRET), galleryShare("42", SECRET));
  assert.equal(readEventShare(galleryShare("42", SECRET), "timeline", SECRET), undefined);
});

test("share tokens refuse short secrets, bad purposes and bad event IDs", () => {
  assert.throws(() => createEventShare("42", "timeline", "short"), /secret/);
  assert.throws(() => readEventShare("42-x", "timeline", ""), /secret/);
  assert.throws(() => createEventShare("42", "Time-line", SECRET), /purpose/);
  assert.throws(() => createEventShare("0", "timeline", SECRET), /event ID/);
});

// --- App origin -----------------------------------------------------------------

test("GUEST_APP_ORIGIN must be an https origin or a loopback http origin, with no path", () => {
  assert.equal(parseAppOrigin(ORIGIN), ORIGIN);
  assert.equal(parseAppOrigin(`${ORIGIN}/`), ORIGIN);
  assert.equal(parseAppOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(parseAppOrigin("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  for (const bad of [
    "http://example.com", `${ORIGIN}/app`, `${ORIGIN}?x=1`, "https://user:pw@example.com",
    "localhost:5173", "ftp://example.com", "", "https://example.com,https://other.com",
  ]) {
    assert.equal(parseAppOrigin(bad), undefined, bad);
  }
  assert.equal(guestTimelineUrl(ORIGIN, "42-abc_-"), `${ORIGIN}/timeline/42-abc_-`);
});

// --- Service --------------------------------------------------------------------

async function setup(options: { secret?: string; origin?: string; eventExists?: boolean } = {}) {
  const store = new MemoryTimelineStore();
  const base = { notes: null, endsAt: null, reminderMinutes: 0 as const, reminderAt: null };
  await store.createItem("42", { ...base, title: "Dinner", place: "Main hall", startsAt: "2026-12-06T01:45:00Z", visibility: "GUESTS" }, "s");
  await store.createItem("42", { ...base, title: "Vendor setup", place: "Back door", startsAt: "2026-12-05T21:00:00Z", visibility: "TEAM" }, "s");
  await store.createItem("42", { ...base, title: "Ceremony", place: "Garden", startsAt: "2026-12-05T23:00:00Z", visibility: "GUESTS" }, "s");
  await store.createItem("77", { ...base, title: "Other event", place: null, startsAt: "2026-12-05T23:00:00Z", visibility: "GUESTS" }, "s");
  const lookedUp: string[] = [];
  const service = new GuestTimelineService({
    repository: store,
    requireMember: memberships([["42", "sub-owner"]]).check,
    events: async (eventId) => {
      lookedUp.push(eventId);
      return options.eventExists === false ? null : { name: "Maya & Eli's Wedding", eventDate: "2026-12-05", venue: "The Willow House" };
    },
    secret: "secret" in options ? options.secret : SECRET,
    origin: "origin" in options ? options.origin : ORIGIN,
  });
  return { service, lookedUp };
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: ApiError) => error.status === status && error.code === code);
}

test("members get the event's guest link; non-members get 403", async () => {
  const { service } = await setup();
  const link = await service.shareLink("42", "sub-owner");
  assert.equal(link.share, createEventShare("42", "timeline", SECRET));
  assert.equal(link.url, `${ORIGIN}/timeline/${link.share}`);
  await rejectsWith(service.shareLink("42", "sub-stranger"), 403, "FORBIDDEN");
  await rejectsWith(service.shareLink("abc", "sub-owner"), 400, "BAD_REQUEST");
});

test("the guest timeline shows only GUESTS activities of that event, in order, with guest-safe fields", async () => {
  const { service } = await setup();
  const timeline = await service.guestTimeline(createEventShare("42", "timeline", SECRET));
  assert.deepEqual(timeline.event, { name: "Maya & Eli's Wedding", eventDate: "2026-12-05", venue: "The Willow House" });
  assert.deepEqual(timeline.items.map((i) => i.title), ["Ceremony", "Dinner"]);
  assert.deepEqual(Object.keys(timeline.items[0]!).sort(), ["endsAt", "itemId", "notes", "place", "startsAt", "title"]);
});

test("bad links, gallery links and deleted events are all the same 404, without touching MySQL for bad links", async () => {
  const { service, lookedUp } = await setup();
  await rejectsWith(service.guestTimeline("42-not-a-real-signature"), 404, "NOT_FOUND");
  await rejectsWith(service.guestTimeline(galleryShare("42", SECRET)), 404, "NOT_FOUND");
  await rejectsWith(service.guestTimeline(undefined), 404, "NOT_FOUND");
  assert.deepEqual(lookedUp, []);

  const deleted = await setup({ eventExists: false });
  await rejectsWith(deleted.service.guestTimeline(createEventShare("42", "timeline", SECRET)), 404, "NOT_FOUND");
});

test("missing or weak settings fail with a configuration error that names the variable", async () => {
  const noSecret = await setup({ secret: undefined });
  await assert.rejects(noSecret.service.guestTimeline("42-x"), (e: Error) =>
    e instanceof TimelineConfigurationError && /TIMELINE_SHARE_SECRET/.test(e.message));
  await assert.rejects((await setup({ secret: "short" })).service.shareLink("42", "sub-owner"), TimelineConfigurationError);
  await assert.rejects((await setup({ origin: "http://example.com" })).service.shareLink("42", "sub-owner"), (e: Error) =>
    e instanceof TimelineConfigurationError && /GUEST_APP_ORIGIN/.test(e.message) && !e.message.includes("example.com"));
});

// --- Event summary lookup ---------------------------------------------------------

test("the event summary reads only name, date and venue with a bound ID", async () => {
  const calls: [string, unknown[]][] = [];
  const lookup = createEventSummaryLookup(async (sql, values) => {
    calls.push([sql, values]);
    return [values[0] === "42" ? [{ name: "Wedding", event_date: "2026-12-05", venue: null }] as never : [], undefined];
  });
  assert.deepEqual(await lookup("42"), { name: "Wedding", eventDate: "2026-12-05", venue: null });
  assert.equal(await lookup("99"), null);
  assert.equal(calls[0]![0], "SELECT name, event_date, venue FROM events WHERE event_id = ? LIMIT 1");
  assert.deepEqual(calls[0]![1], ["42"]);
});
