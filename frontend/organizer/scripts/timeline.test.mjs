import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

const t = loadModule("../src/features/planning/timelineFormat.ts");

// Vancouver's UTC offset for a wall-clock time, read from the runtime's time-zone data
// (e.g. "-08:00", or "-07:00" under B.C.'s permanent daylight time). The tests never
// hard-code an offset, so they pass with old and new tz data alike.
function offset(date, time) {
  for (const guess of [-480, -420]) {
    const instant = new Date(Date.parse(`${date}T${time}:00Z`) - guess * 60_000);
    const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "longOffset" })
      .formatToParts(instant).find((part) => part.type === "timeZoneName").value; // "GMT-07:00"
    const minutes = Number(name.slice(4, 6)) * 60 + Number(name.slice(7, 9));
    if (-minutes === guess) return name.slice(3);
  }
  throw new Error(`no consistent offset for ${date} ${time}`);
}
const local = (date, time) => `${date}T${time}:00${offset(date, time)}`;
/** The UTC instant for a Vancouver wall-clock time. */
const utc = (date, time) => new Date(local(date, time)).toISOString().replace(".000Z", "Z");

const item = (overrides = {}) => ({
  eventId: "42", itemId: "a", title: "Ceremony begins", place: "Garden", notes: null,
  startsAt: utc("2026-12-05", "15:00"), endsAt: utc("2026-12-05", "15:30"), visibility: "GUESTS",
  reminderMinutes: 60, reminderAt: utc("2026-12-05", "14:00"), reminderSent: false, version: 3,
  createdAt: "2026-11-24T05:00:00Z", updatedAt: "2026-11-24T05:00:00Z", ...overrides,
});

test("Vancouver wall-clock time converts to an instant with the right offset, in winter and summer", () => {
  assert.equal(t.localToInstant("2026-12-05", "15:00"), local("2026-12-05", "15:00"));
  assert.equal(t.localToInstant("2026-07-01", "15:00"), "2026-07-01T15:00:00-07:00");
  assert.equal(t.localToInstant("2026-12-05", "23:59"), local("2026-12-05", "23:59"));
  // A 2025 winter date is standard time in every tz data version.
  assert.equal(t.localToInstant("2025-12-05", "15:00"), "2025-12-05T15:00:00-08:00");
});

test("clock times skipped by the DST change and malformed input are rejected", () => {
  assert.equal(t.localToInstant("2025-03-09", "02:30"), null); // 2:00 jumped to 3:00
  assert.equal(t.localToInstant("2025-03-09", "03:00"), "2025-03-09T03:00:00-07:00");
  assert.equal(t.localToInstant("2026-12-05", "24:00"), null);
  assert.equal(t.localToInstant("12/05/2026", "15:00"), null);
  assert.equal(t.localToInstant("2026-12-05", ""), null);
});

test("UTC instants show in Vancouver time, including the date across midnight UTC", () => {
  assert.deepEqual(t.instantToLocal(utc("2026-12-05", "15:00")), { date: "2026-12-05", time: "15:00" });
  // 11:30 PM local is already the next day in UTC.
  assert.ok(utc("2026-12-05", "23:30").startsWith("2026-12-06"));
  assert.deepEqual(t.instantToLocal(utc("2026-12-05", "23:30")), { date: "2026-12-05", time: "23:30" });
  assert.equal(t.formatTime(utc("2026-12-05", "15:00")), "3:00 PM");
  assert.equal(t.formatRange(item()), "3:00 PM – 3:30 PM");
  assert.equal(t.formatRange(item({ endsAt: null })), "3:00 PM");
  assert.equal(t.formatDay("2026-12-05"), "Saturday, December 5, 2026");
  assert.deepEqual(t.dateBadge("2026-12-05"), { weekday: "SATURDAY", day: "5", monthYear: "December 2026" });
  assert.equal(t.dateBadge(null), null);
});

test("items group by Vancouver day, so a late-night activity stays on its local date", () => {
  const groups = t.groupByDay([
    item({ itemId: "a", startsAt: utc("2026-12-05", "15:00") }),
    item({ itemId: "b", startsAt: utc("2026-12-05", "23:30") }), // next day in UTC
    item({ itemId: "c", startsAt: utc("2026-12-06", "10:00") }),
  ]);
  assert.deepEqual(groups.map((g) => [g.date, g.items.map((i) => i.itemId)]), [
    ["2026-12-05", ["a", "b"]],
    ["2026-12-06", ["c"]],
  ]);
  assert.equal(groups[0].label, "Saturday, December 5, 2026");
});

test("grouping and 'up next' don't depend on the order items arrive in", () => {
  const shuffled = [
    item({ itemId: "late", startsAt: utc("2026-12-05", "20:00") }),
    item({ itemId: "other-day", startsAt: utc("2026-12-04", "18:00") }),
    item({ itemId: "early", startsAt: utc("2026-12-05", "15:00") }),
  ];
  assert.deepEqual(t.groupByDay(shuffled).map((g) => [g.date, g.items.map((i) => i.itemId)]), [
    ["2026-12-04", ["other-day"]],
    ["2026-12-05", ["early", "late"]],
  ]);
  assert.equal(t.nextUpItemId(shuffled, new Date(utc("2026-12-05", "12:00"))), "early");
});

test("the next activity is the first one that hasn't started", () => {
  const items = [item({ itemId: "a", startsAt: "2026-12-05T22:00:00Z" }), item({ itemId: "b", startsAt: "2026-12-05T23:00:00Z" })];
  assert.equal(t.nextUpItemId(items, new Date("2026-12-05T22:30:00Z")), "b");
  assert.equal(t.nextUpItemId(items, new Date("2026-12-06T00:00:00Z")), null);
});

test("the form round-trips an item and validates like the API", () => {
  const form = t.formFromItem(item({ notes: "Bring umbrellas" }));
  assert.deepEqual(form, {
    title: "Ceremony begins", date: "2026-12-05", startTime: "15:00", endTime: "15:30",
    place: "Garden", notes: "Bring umbrellas", visibility: "GUESTS", reminderMinutes: "60",
  });
  assert.deepEqual(t.validateForm(form).fields, {
    title: "Ceremony begins", place: "Garden", notes: "Bring umbrellas",
    startsAt: local("2026-12-05", "15:00"), endsAt: local("2026-12-05", "15:30"),
    visibility: "GUESTS", reminderMinutes: 60,
  });
  assert.deepEqual(t.emptyForm("2026-12-05"), {
    title: "", date: "2026-12-05", startTime: "", endTime: "", place: "", notes: "", visibility: "GUESTS", reminderMinutes: "60",
  });
});

test("form validation reports missing and too-long values, and blank optional text becomes null", () => {
  const { errors, fields } = t.validateForm({ ...t.emptyForm(null), title: " ", place: "x".repeat(161) });
  assert.equal(fields, undefined);
  assert.deepEqual(Object.keys(errors).sort(), ["date", "place", "startTime", "title"]);
  const ok = t.validateForm({ ...t.emptyForm("2026-12-05"), title: " Dinner ", startTime: "18:00", place: "  " });
  assert.equal(ok.fields.title, "Dinner");
  assert.equal(ok.fields.place, null);
  assert.equal(ok.fields.endsAt, null);
});

test("an end time before the start time means the activity runs past midnight", () => {
  const { fields } = t.validateForm({ ...t.emptyForm("2026-12-05"), title: "Dancing", startTime: "21:00", endTime: "01:00" });
  assert.equal(fields.endsAt, local("2026-12-06", "01:00"));
});

test("an edit sends only the changed fields, comparing times as instants", () => {
  const stored = item();
  assert.deepEqual(t.changedFields(stored, t.validateForm(t.formFromItem(stored)).fields), {});
  const moved = t.validateForm({ ...t.formFromItem(stored), startTime: "15:30", endTime: "", notes: "x" }).fields;
  assert.deepEqual(t.changedFields(stored, moved), { notes: "x", startsAt: local("2026-12-05", "15:30"), endsAt: null });
  assert.equal(t.isNotifiableChange({ notes: "x" }), false);
  assert.equal(t.isNotifiableChange({ notes: "x", startsAt: "…" }), true);
});

test("API field errors land on the matching inputs", () => {
  assert.deepEqual(t.formErrorsFromApi({ startsAt: "Bad", endsAt: "Must be after", body: "Nothing to change" }), {
    startTime: "Bad", endTime: "Must be after", form: "Nothing to change",
  });
  assert.deepEqual(t.formErrorsFromApi(undefined), {});
});

test("save messages explain what happened to the update emails", () => {
  assert.equal(t.savedMessage("Saved"), "Saved.");
  assert.equal(t.savedMessage("Saved", { status: "QUEUED", recipients: 1 }), "Saved. Emailing 1 person about the change.");
  assert.equal(t.savedMessage("Deleted", { status: "QUEUED", recipients: 14 }), "Deleted. Emailing 14 people about the change.");
  assert.match(t.savedMessage("Saved", { status: "FAILED", recipients: 0 }), /couldn't be sent/);
  assert.match(t.savedMessage("Saved", { status: "NO_CHANGE", recipients: 0 }), /no email/);
});

const nav = loadModule("../src/routes/navigation.ts");

test("guest gallery and guest timeline links skip the organizer session check; app pages don't", () => {
  for (const path of ["/gallery/42-abc", "/timeline/42-abc_-", "/timeline/42-abc/", "/Timeline/42-abc"]) {
    assert.equal(nav.isPublicGuestPage(path), true, path);
  }
  for (const path of ["/app/timeline", "/timeline", "/timeline/", "/timeline/42/extra", "/login", "/"]) {
    assert.equal(nav.isPublicGuestPage(path), false, path);
  }
  assert.equal(nav.guestTimelinePath("42-a_b"), "/timeline/42-a_b");
  assert.equal(nav.guestTimelinePath("x/y"), "/timeline/x%2Fy");
});
