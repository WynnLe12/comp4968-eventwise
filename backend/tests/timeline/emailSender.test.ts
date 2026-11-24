// Timeline email content and the SQS -> SES sender Lambda (no AWS needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createEmailSenderHandler, createSesSender, type SendEmail } from "../../timeline-service/lambda/emailSender";
import { describeChanges, escapeHtml, formatWhen, parseEmailMessage, renderEmail } from "../../timeline-service/notifications/emailContent";
import type { TimelineEmailMessage } from "../../timeline-service/notifications/messages";

// Wall-clock times in Vancouver, read from the runtime's time-zone data (never hard-coded).
function vancouverUtc(date: string, time: string): string {
  for (const guess of [-480, -420]) {
    const instant = new Date(Date.parse(`${date}T${time}:00Z`) - guess * 60_000);
    const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "longOffset" })
      .formatToParts(instant).find((part) => part.type === "timeZoneName")!.value;
    if (-(Number(name.slice(4, 6)) * 60 + Number(name.slice(7, 9))) === guess) return instant.toISOString().replace(".000Z", "Z");
  }
  throw new Error("no offset");
}

const URL_GUEST = "https://main.example.amplifyapp.com/timeline/42-abc";
const at3 = vancouverUtc("2026-12-05", "15:00");
const at330 = vancouverUtc("2026-12-05", "15:30");

const reminder: TimelineEmailMessage = {
  type: "TIMELINE_REMINDER", to: "aunt.jo@example.com", audience: "GUEST", eventName: "Maya & Eli's Wedding",
  item: { title: "Ceremony begins", place: "Garden", startsAt: at3, endsAt: at330 }, timelineUrl: URL_GUEST,
};
const update: TimelineEmailMessage = {
  ...reminder, type: "TIMELINE_CHANGED", change: "UPDATED", changedFields: ["startsAt", "place"],
  previous: { title: "Ceremony begins", place: "Garden", startsAt: at3, endsAt: null },
  item: { title: "Ceremony begins", place: "Main hall", startsAt: at330, endsAt: null },
};
const deleted: TimelineEmailMessage = { ...reminder, type: "TIMELINE_CHANGED", change: "DELETED" };

// --- Content ----------------------------------------------------------------------------

test("reminder: subject with the time and event, body with when, where and the schedule link", () => {
  const email = renderEmail(reminder);
  assert.equal(email.subject, "Reminder: Ceremony begins at 3:00 PM · Maya & Eli's Wedding");
  assert.match(email.text, /^Maya & Eli's Wedding\n\nCeremony begins starts soon\.\n\nWhen: Saturday, December 5, 3:00 PM – 3:30 PM\nWhere: Garden\n/);
  assert.match(email.text, /See the full schedule: https:\/\/main\.example\.amplifyapp\.com\/timeline\/42-abc/);
  assert.match(email.text, /on the guest list for Maya & Eli's Wedding/);
});

test("update: says what moved, from what to what", () => {
  const email = renderEmail(update);
  assert.equal(email.subject, "Schedule update: Ceremony begins · Maya & Eli's Wedding");
  assert.deepEqual(describeChanges(update), [
    "Time: Saturday, December 5: 3:00 PM → 3:30 PM",
    "Place: Garden → Main hall",
  ]);
  assert.match(email.text, /Now: Saturday, December 5, 3:30 PM at Main hall/);
});

test("renames and visibility changes are explained per audience", () => {
  const renamed = { ...update, changedFields: ["title", "visibility"] as TimelineEmailMessage["changedFields"],
    previous: { ...update.previous!, title: "Vows" }, item: { ...update.item, title: "Ceremony" } };
  assert.deepEqual(describeChanges(renamed), ["Name: “Vows” → “Ceremony”", "This activity is no longer part of the guest schedule."]);
  assert.deepEqual(describeChanges({ ...renamed, audience: "ORGANIZER" })[1], "Who can see this activity changed.");
});

test("deleted: names the activity that was removed", () => {
  const email = renderEmail(deleted);
  assert.equal(email.subject, "Removed from the schedule: Ceremony begins · Maya & Eli's Wedding");
  assert.match(email.text, /Ceremony begins \(Saturday, December 5, 3:00 PM – 3:30 PM at Garden\) has been removed/);
});

test("organizers get the app link and a way to turn emails off", () => {
  const email = renderEmail({ ...reminder, audience: "ORGANIZER", timelineUrl: "https://main.example.amplifyapp.com/app/timeline" });
  assert.match(email.text, /Open the timeline: https:\/\/main\.example\.amplifyapp\.com\/app\/timeline/);
  assert.match(email.text, /turn them off on the Timeline page/);
});

test("a move to another day spells out both dates", () => {
  const moved = { ...update, changedFields: ["startsAt"] as TimelineEmailMessage["changedFields"],
    item: { ...update.item, startsAt: vancouverUtc("2026-12-06", "10:00") } };
  assert.deepEqual(describeChanges(moved), ["Time: Saturday, December 5, 3:00 PM → Sunday, December 6, 10:00 AM"]);
});

test("an activity past midnight shows both days", () => {
  const late = { startsAt: vancouverUtc("2026-12-05", "21:00"), endsAt: vancouverUtc("2026-12-06", "01:00") };
  assert.equal(formatWhen(late), "Saturday, December 5, 9:00 PM – Sunday, December 6, 1:00 AM");
});

test("HTML escapes everything from users, and subjects stay on one line", () => {
  const email = renderEmail({ ...reminder, eventName: "<script>alert(1)</script>", item: { ...reminder.item, title: "A\nB & \"C\"" } });
  assert.equal(email.html.includes("<script>"), false);
  assert.match(email.html, /&lt;script&gt;/);
  assert.match(email.html, /A\nB &amp; &quot;C&quot;/);
  assert.equal(email.subject.includes("\n"), false);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

// --- Message validation -------------------------------------------------------------------

test("only messages matching the contract are accepted", () => {
  for (const message of [reminder, update, deleted]) assert.deepEqual(parseEmailMessage(JSON.stringify(message)), message);
  const bad: unknown[] = [
    "not json",
    { ...reminder, to: "not-an-email" },
    { ...reminder, audience: "ADMIN" },
    { ...reminder, type: "SPAM" },
    { ...reminder, timelineUrl: "javascript:alert(1)" },
    { ...reminder, timelineUrl: "http://evil.example.com" },
    { ...reminder, item: { ...reminder.item, startsAt: "tomorrow" } },
    { ...update, previous: undefined },
    { ...update, changedFields: ["eventId"] },
    { ...deleted, change: "MOVED" },
  ];
  for (const value of bad) assert.equal(parseEmailMessage(typeof value === "string" ? value : JSON.stringify(value)), null, JSON.stringify(value));
});

// --- Sender Lambda -----------------------------------------------------------------------

function sender(fail: (to: string) => Error | null = () => null, env: NodeJS.ProcessEnv = { SES_FROM_ADDRESS: "EventWise <no-reply@example.com>" }) {
  const sent: Parameters<SendEmail>[0][] = [];
  const logged: string[] = [];
  const handler = createEmailSenderHandler(async (input) => {
    const error = fail(input.to);
    if (error) throw error;
    sent.push(input);
  }, env, (line) => logged.push(line));
  return { handler, sent, logged };
}

const record = (messageId: string, message: unknown) => ({ messageId, body: typeof message === "string" ? message : JSON.stringify(message) });

test("each SQS message becomes one SES email from the configured sender", async () => {
  const { handler, sent } = sender();
  const result = await handler({ Records: [record("m1", reminder), record("m2", { ...update, to: "o@example.com" })] });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(sent.map((s) => [s.from, s.to, s.subject]), [
    ["EventWise <no-reply@example.com>", "aunt.jo@example.com", "Reminder: Ceremony begins at 3:00 PM · Maya & Eli's Wedding"],
    ["EventWise <no-reply@example.com>", "o@example.com", "Schedule update: Ceremony begins · Maya & Eli's Wedding"],
  ]);
});

test("SES failures and malformed messages are reported as batch item failures; logs hold no addresses", async () => {
  const rejected = Object.assign(new Error("Email address is not verified: aunt.jo@example.com"), { name: "MessageRejected" });
  const { handler, sent, logged } = sender((to) => (to === "aunt.jo@example.com" ? rejected : null));
  const result = await handler({ Records: [record("m1", reminder), record("m2", "{oops"), record("m3", { ...reminder, to: "x@example.com" })] });
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
  assert.deepEqual(sent.map((s) => s.to), ["x@example.com"]);
  assert.deepEqual(logged, [
    "Timeline email m1 failed: MessageRejected",
    "Timeline email m2 rejected: message does not match the contract",
  ]);
});

test("without SES_FROM_ADDRESS every message is retried and nothing is sent", async () => {
  const { handler, sent, logged } = sender(() => null, {});
  const result = await handler({ Records: [record("m1", reminder), record("m2", update)] });
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
  assert.equal(sent.length, 0);
  assert.deepEqual(logged, ["SES_FROM_ADDRESS must be set for timeline emails"]);
  assert.deepEqual(await handler({}), { batchItemFailures: [] });
});

test("the SES request carries the sender, one recipient and UTF-8 text and HTML", async () => {
  const commands: SendEmailCommand[] = [];
  const send = createSesSender({ send: async (command: SendEmailCommand) => { commands.push(command); return {}; } } as never);
  await send({ from: "no-reply@example.com", to: "a@example.com", subject: "S", text: "T", html: "<p>H</p>" });
  assert.deepEqual(commands[0]!.input, {
    FromEmailAddress: "no-reply@example.com",
    Destination: { ToAddresses: ["a@example.com"] },
    Content: { Simple: {
      Subject: { Data: "S", Charset: "UTF-8" },
      Body: { Text: { Data: "T", Charset: "UTF-8" }, Html: { Data: "<p>H</p>", Charset: "UTF-8" } },
    } },
  });
});
