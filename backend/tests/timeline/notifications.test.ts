// Change notifications: recipients, message contract, SQS batching and the notifier,
// end to end from a PATCH (no AWS, Docker or MySQL).

import assert from "node:assert/strict";
import { test } from "node:test";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { createEventShare } from "../../shared/auth/eventShare";
import { TimelineConfigurationError } from "../../timeline-service/errors";
import { changeMessages, reminderMessages, timelineLinks } from "../../timeline-service/notifications/messages";
import { SQS_BATCH_LIMIT, createSqsPublisher } from "../../timeline-service/notifications/publisher";
import { MAX_RECIPIENTS, RecipientResolver, createMemberSubsLookup } from "../../timeline-service/notifications/recipients";
import { SqsTimelineNotifier } from "../../timeline-service/notifications/sqsNotifier";
import { TimelineService } from "../../timeline-service/services/timelineService";
import type { TimelineRecord } from "../../timeline-service/types";
import { MemoryTimelineStore, memberships } from "./fakes";

const SECRET = "timeline-secret-0123456789abcdef-xyz";
const ORIGIN = "https://main.example.amplifyapp.com";
const LINKS = { origin: ORIGIN, secret: SECRET };

// --- Recipients -----------------------------------------------------------------------

async function resolver(options: {
  subscribers?: [sub: string, email: string][];
  members?: string[];
  guests?: { email?: string; rsvpStatus: string }[];
} = {}) {
  const store = new MemoryTimelineStore();
  for (const [sub, email] of options.subscribers ?? [["sub-owner", "maya@example.com"], ["sub-planner", "eli@example.com"]]) {
    await store.putSubscriber("42", sub, email);
  }
  const guestCalls: string[] = [];
  const recipients = new RecipientResolver({
    subscribers: store,
    members: async () => new Set(options.members ?? ["sub-owner", "sub-planner"]),
    guests: async (eventId) => {
      guestCalls.push(eventId);
      return options.guests ?? [
        { email: "aunt.jo@example.com", rsvpStatus: "ATTENDING" },
        { email: "Pending@Example.com ", rsvpStatus: "PENDING" },
        { email: "no.thanks@example.com", rsvpStatus: "DECLINED" },
        { rsvpStatus: "ATTENDING" },
      ];
    },
  });
  return { recipients, guestCalls };
}

test("a TEAM activity reaches subscribed organizers only, without reading the guest list", async () => {
  const { recipients, guestCalls } = await resolver();
  const { recipients: list } = await recipients.resolve("42", new Set(["TEAM"]));
  assert.deepEqual(list, [
    { email: "maya@example.com", audience: "ORGANIZER" },
    { email: "eli@example.com", audience: "ORGANIZER" },
  ]);
  assert.deepEqual(guestCalls, []);
});

test("a GUESTS activity adds guests with an email who haven't declined", async () => {
  const { recipients } = await resolver();
  const { recipients: list } = await recipients.resolve("42", new Set(["GUESTS"]));
  assert.deepEqual(list.map((r) => `${r.audience}:${r.email}`), [
    "ORGANIZER:maya@example.com", "ORGANIZER:eli@example.com", "GUEST:aunt.jo@example.com", "GUEST:pending@example.com",
  ]);
});

test("a removed co-planner's subscription is ignored, and one address gets one email", async () => {
  const { recipients } = await resolver({
    members: ["sub-owner"],
    guests: [{ email: "MAYA@example.com", rsvpStatus: "ATTENDING" }, { email: "x@example.com", rsvpStatus: "PENDING" }],
  });
  const { recipients: list } = await recipients.resolve("42", new Set(["GUESTS"]));
  assert.deepEqual(list, [
    { email: "maya@example.com", audience: "ORGANIZER" },
    { email: "x@example.com", audience: "GUEST" },
  ]);
});

test("very large audiences are capped and reported as truncated", async () => {
  const guests = Array.from({ length: MAX_RECIPIENTS + 5 }, (_, i) => ({ email: `g${i}@example.com`, rsvpStatus: "PENDING" }));
  const { recipients } = await resolver({ guests });
  const result = await recipients.resolve("42", new Set(["GUESTS"]));
  assert.equal(result.recipients.length, MAX_RECIPIENTS);
  assert.equal(result.truncated, true);
});

test("member lookup reads only the event's Cognito subs with a bound ID", async () => {
  const calls: [string, unknown[]][] = [];
  const lookup = createMemberSubsLookup(async (sql, values) => {
    calls.push([sql, values]);
    return [[{ cognito_sub: "a" }, { cognito_sub: "b" }] as never, undefined];
  });
  assert.deepEqual([...await lookup("42")], ["a", "b"]);
  assert.deepEqual(calls, [["SELECT cognito_sub FROM event_members WHERE event_id = ?", ["42"]]]);
});

// --- Messages -------------------------------------------------------------------------

const record = (overrides: Partial<TimelineRecord> = {}): TimelineRecord => ({
  eventId: "42", sk: "ITEM#a", itemId: "a", title: "Ceremony begins", place: "Garden",
  startsAt: "2026-12-05T23:00:00Z", visibility: "GUESTS", reminderMinutes: 60, version: 3,
  createdBy: "s", updatedBy: "s", createdAt: "t", updatedAt: "t", ...overrides,
});

test("guests get their schedule link and organizers get the app; settings are required", () => {
  const links = timelineLinks("42", LINKS);
  assert.equal(links.GUEST, `${ORIGIN}/timeline/${createEventShare("42", "timeline", SECRET)}`);
  assert.equal(links.ORGANIZER, `${ORIGIN}/app/timeline`);
  assert.throws(() => timelineLinks("42", { secret: SECRET }), (e: Error) => e instanceof TimelineConfigurationError && /GUEST_APP_ORIGIN/.test(e.message));
  assert.throws(() => timelineLinks("42", { origin: ORIGIN, secret: "short" }), /TIMELINE_SHARE_SECRET/);
  assert.throws(() => timelineLinks("42", { origin: "http://example.com", secret: SECRET }), /GUEST_APP_ORIGIN/);
});

test("an UPDATED message carries the new activity, the old one and the changed fields", () => {
  const links = timelineLinks("42", LINKS);
  const [guest, organizer] = changeMessages(
    [{ email: "g@example.com", audience: "GUEST" }, { email: "o@example.com", audience: "ORGANIZER" }],
    { type: "UPDATED", before: record(), after: record({ startsAt: "2026-12-05T23:30:00Z", place: undefined }), changedFields: ["place", "startsAt"] },
    { eventName: "Maya & Eli's Wedding", links },
  );
  assert.deepEqual(guest, {
    type: "TIMELINE_CHANGED",
    to: "g@example.com",
    audience: "GUEST",
    eventName: "Maya & Eli's Wedding",
    change: "UPDATED",
    changedFields: ["place", "startsAt"],
    previous: { title: "Ceremony begins", place: "Garden", startsAt: "2026-12-05T23:00:00Z", endsAt: null },
    item: { title: "Ceremony begins", place: null, startsAt: "2026-12-05T23:30:00Z", endsAt: null },
    timelineUrl: links.GUEST,
  });
  assert.equal(organizer!.timelineUrl, links.ORGANIZER);
});

test("DELETED and reminder messages carry only the activity", () => {
  const links = timelineLinks("42", LINKS);
  const [deleted] = changeMessages([{ email: "g@example.com", audience: "GUEST" }],
    { type: "DELETED", before: record(), after: null, changedFields: [] }, { eventName: "E", links });
  assert.equal(deleted!.change, "DELETED");
  assert.equal("previous" in deleted!, false);
  assert.equal("changedFields" in deleted!, false);
  assert.equal(deleted!.item.title, "Ceremony begins");

  const [reminder] = reminderMessages([{ email: "o@example.com", audience: "ORGANIZER" }], record(), { eventName: "E", links });
  assert.deepEqual(Object.keys(reminder!).sort(), ["audience", "eventName", "item", "timelineUrl", "to", "type"]);
  assert.equal(reminder!.type, "TIMELINE_REMINDER");
});

// --- Publisher ------------------------------------------------------------------------

function fakeSqs(answer: (entries: number, call: number) => unknown) {
  const calls: SendMessageBatchCommand[] = [];
  const client = {
    async send(command: SendMessageBatchCommand) {
      calls.push(command);
      return answer(command.input.Entries!.length, calls.length);
    },
  };
  return { client: client as never, calls };
}

const message = (i: number) => ({
  type: "TIMELINE_REMINDER" as const, to: `p${i}@example.com`, audience: "GUEST" as const, eventName: "E",
  item: { title: "T", place: null, startsAt: "2026-12-05T23:00:00Z", endsAt: null }, timelineUrl: "u",
});

test("messages go out in batches of 10 with the JSON body untouched", async () => {
  const sqs = fakeSqs(() => ({}));
  const publish = createSqsPublisher("https://sqs.us-west-2.amazonaws.com/1/eventwise-timeline-emails", sqs.client);
  assert.deepEqual(await publish(Array.from({ length: 23 }, (_, i) => message(i))), { queued: 23, failed: 0 });
  assert.deepEqual(sqs.calls.map((c) => c.input.Entries!.length), [SQS_BATCH_LIMIT, SQS_BATCH_LIMIT, 3]);
  assert.equal(sqs.calls[0]!.input.QueueUrl, "https://sqs.us-west-2.amazonaws.com/1/eventwise-timeline-emails");
  assert.deepEqual(JSON.parse(sqs.calls[2]!.input.Entries![0]!.MessageBody!), message(20));
});

test("partial and whole-batch failures are counted, not thrown", async () => {
  const sqs = fakeSqs((_entries, call) => {
    if (call === 1) return { Failed: [{ Id: "3" }, { Id: "4" }] };
    throw new Error("endpoint unreachable");
  });
  const publish = createSqsPublisher("https://queue", sqs.client);
  assert.deepEqual(await publish(Array.from({ length: 15 }, (_, i) => message(i))), { queued: 8, failed: 7 });
});

test("a missing queue URL is a configuration error", async () => {
  await assert.rejects(createSqsPublisher(undefined, fakeSqs(() => ({})).client)([message(1)]),
    (e: Error) => e instanceof TimelineConfigurationError && /TIMELINE_EMAIL_QUEUE_URL/.test(e.message));
});

// --- Notifier, end to end from a PATCH ------------------------------------------------

async function endToEnd(publishAnswer: { queued: number; failed: number } | Error = { queued: -1, failed: 0 }) {
  const store = new MemoryTimelineStore();
  await store.putSubscriber("42", "sub-owner", "maya@example.com");
  const published: unknown[][] = [];
  const logged: string[] = [];
  const notifier = new SqsTimelineNotifier({
    recipients: new RecipientResolver({
      subscribers: store,
      members: async () => new Set(["sub-owner", "sub-planner"]),
      guests: async () => [{ email: "aunt.jo@example.com", rsvpStatus: "ATTENDING" }],
    }),
    publish: async (messages) => {
      published.push(messages);
      if (publishAnswer instanceof Error) throw publishAnswer;
      return publishAnswer.queued === -1 ? { queued: messages.length, failed: 0 } : publishAnswer;
    },
    events: async () => ({ name: "Maya & Eli's Wedding", eventDate: "2026-12-05", venue: null }),
    links: LINKS,
    log: (line) => logged.push(line),
  });
  const service = new TimelineService({
    repository: store,
    requireMember: memberships([["42", "sub-owner"], ["42", "sub-planner"]]).check,
    notifier,
    now: () => new Date("2026-12-01T12:00:00Z"),
    logError: (line) => logged.push(line),
  });
  return { service, published, logged };
}

test("moving a guest activity with notify emails organizers and guests, and logs only counts", async () => {
  const { service, published, logged } = await endToEnd();
  const item = await service.create("42", "sub-planner", { title: "Ceremony", startsAt: "2026-12-05T23:00:00Z" });
  const result = await service.update("42", item.itemId, "sub-planner", { version: 1, startsAt: "2026-12-05T23:30:00Z", notify: true });
  assert.deepEqual(result.notification, { status: "QUEUED", recipients: 2 });
  const messages = published[0] as { to: string; audience: string; eventName: string; timelineUrl: string }[];
  assert.deepEqual(messages.map((m) => `${m.audience}:${m.to}`), ["ORGANIZER:maya@example.com", "GUEST:aunt.jo@example.com"]);
  assert.equal(messages[0]!.eventName, "Maya & Eli's Wedding");
  assert.deepEqual(logged, ["Timeline updated for event 42: 2 queued, 0 failed"]);
  assert.equal(logged.join(" ").includes("@"), false);
});

test("hiding an activity from guests still tells the guests once", async () => {
  const { service, published } = await endToEnd();
  const item = await service.create("42", "sub-owner", { title: "Toast", startsAt: "2026-12-05T23:00:00Z" });
  await service.update("42", item.itemId, "sub-owner", { version: 1, visibility: "TEAM", notify: true });
  assert.deepEqual((published[0] as { to: string }[]).map((m) => m.to), ["maya@example.com", "aunt.jo@example.com"]);
});

test("a TEAM-only change never emails guests; no subscribers means NO_RECIPIENTS", async () => {
  const { service, published } = await endToEnd();
  const item = await service.create("42", "sub-owner", { title: "Vendor setup", startsAt: "2026-12-05T21:00:00Z", visibility: "TEAM" });
  await service.update("42", item.itemId, "sub-owner", { version: 1, place: "Back door", notify: true });
  assert.deepEqual((published[0] as { to: string }[]).map((m) => m.to), ["maya@example.com"]);

  const quiet = await endToEnd();
  const store = new MemoryTimelineStore();
  const lonely = new SqsTimelineNotifier({
    recipients: new RecipientResolver({ subscribers: store, members: async () => new Set(), guests: async () => [] }),
    publish: async () => assert.fail("nothing should be published"),
    events: async () => null,
    links: LINKS,
  });
  assert.deepEqual(await lonely.timelineChanged({ type: "DELETED", eventId: "42", before: record({ visibility: "TEAM" }), after: null, changedFields: [] }),
    { status: "NO_RECIPIENTS", recipients: 0 });
  assert.equal(quiet.published.length, 0);
});

test("partial SQS failures and missing settings report FAILED; the edit is still saved", async () => {
  const partial = await endToEnd({ queued: 1, failed: 1 });
  const item = await partial.service.create("42", "sub-owner", { title: "Dinner", startsAt: "2026-12-06T01:45:00Z" });
  const result = await partial.service.update("42", item.itemId, "sub-owner", { version: 1, title: "Dinner is served", notify: true });
  assert.deepEqual(result.notification, { status: "FAILED", recipients: 1 });
  assert.equal(result.item.title, "Dinner is served");

  const broken = await endToEnd(new TimelineConfigurationError("TIMELINE_EMAIL_QUEUE_URL must be set for timeline emails"));
  const other = await broken.service.create("42", "sub-owner", { title: "Dinner", startsAt: "2026-12-06T01:45:00Z" });
  const failed = await broken.service.update("42", other.itemId, "sub-owner", { version: 1, title: "Supper", notify: true });
  assert.deepEqual(failed.notification, { status: "FAILED", recipients: 0 });
});
