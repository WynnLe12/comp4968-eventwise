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

const r = loadModule("../src/features/planning/taskRules.ts");

const task = (id, overrides = {}) => ({
  id, title: `Task ${id}`, description: null, dueDate: null, isCompleted: false, assignee: null, ...overrides,
});
const member = (memberId, displayName = null) => ({ memberId, displayName, role: "CO_PLANNER" });

test("localToday uses the browser's local calendar date, not UTC", () => {
  // 11:30 pm local on Nov 25 is already Nov 26 in UTC west of Greenwich.
  assert.equal(r.localToday(new Date(2026, 10, 25, 23, 30)), "2026-11-25");
  assert.equal(r.localToday(new Date(2027, 0, 5, 0, 5)), "2027-01-05");
});

test("addDays crosses month, year and leap-day boundaries", () => {
  assert.equal(r.addDays("2026-12-28", 6), "2027-01-03");
  assert.equal(r.addDays("2028-02-27", 2), "2028-02-29");
  assert.equal(r.addDays("2027-03-01", -1), "2027-02-28");
});

test("overdue means open with a due date before today", () => {
  const today = "2026-11-25";
  assert.equal(r.isOverdue(task("1", { dueDate: "2026-11-24" }), today), true);
  assert.equal(r.isOverdue(task("1", { dueDate: "2026-11-25" }), today), false, "due today isn't overdue");
  assert.equal(r.isOverdue(task("1", { dueDate: "2026-11-01", isCompleted: true }), today), false);
  assert.equal(r.isOverdue(task("1"), today), false, "no due date is never overdue");
});

test("due this week is today through 6 days from now, open only", () => {
  const today = "2026-11-25";
  assert.equal(r.isDueThisWeek(task("1", { dueDate: "2026-11-25" }), today), true);
  assert.equal(r.isDueThisWeek(task("1", { dueDate: "2026-12-01" }), today), true);
  assert.equal(r.isDueThisWeek(task("1", { dueDate: "2026-12-02" }), today), false);
  assert.equal(r.isDueThisWeek(task("1", { dueDate: "2026-11-24" }), today), false, "overdue is counted separately");
  assert.equal(r.isDueThisWeek(task("1", { dueDate: "2026-11-26", isCompleted: true }), today), false);
});

test("progress matches the API's rounding and never divides by zero", () => {
  assert.deepEqual(r.progressOf([]), { total: 0, completed: 0, open: 0, percentComplete: 0 });
  const three = [task("1", { isCompleted: true }), task("2", { isCompleted: true }), task("3")];
  assert.deepEqual(r.progressOf(three), { total: 3, completed: 2, open: 1, percentComplete: 67 });
});

test("sortTasks: open first, then due date (undated last), then by numeric ID", () => {
  const sorted = r.sortTasks([
    task("10", { isCompleted: true, dueDate: "2026-01-01" }),
    task("9"),
    task("3", { dueDate: "2027-02-01" }),
    task("12", { dueDate: "2027-01-01" }),
    task("100"),
  ]);
  assert.deepEqual(sorted.map((t) => t.id), ["12", "3", "9", "100", "10"]);
});

test("replaceTask swaps in the saved task, or adds a new one, and keeps the order", () => {
  const list = [task("1", { dueDate: "2027-01-01" }), task("2", { dueDate: "2027-02-01" })];
  assert.deepEqual(r.replaceTask(list, task("1", { dueDate: "2027-03-01" })).map((t) => t.id), ["2", "1"]);
  assert.deepEqual(r.replaceTask(list, task("3", { dueDate: "2026-12-01" })).map((t) => t.id), ["3", "1", "2"]);
});

test("filterTasks by tab and assignee", () => {
  const list = [
    task("1", { assignee: member("7") }),
    task("2", { assignee: member("8"), isCompleted: true }),
    task("3"),
  ];
  const ids = (tab, who, me = "7") => r.filterTasks(list, tab, who, me).map((t) => t.id);
  assert.deepEqual(ids("all", "all"), ["1", "2", "3"]);
  assert.deepEqual(ids("open", "all"), ["1", "3"]);
  assert.deepEqual(ids("done", "all"), ["2"]);
  assert.deepEqual(ids("all", "me"), ["1"]);
  assert.deepEqual(ids("all", "me", null), [], "no 'me' match when my membership isn't known");
  assert.deepEqual(ids("all", "none"), ["3"]);
  assert.deepEqual(ids("all", "8"), ["2"]);
});

test("initials", () => {
  assert.equal(r.initials("Min Baker"), "MB");
  assert.equal(r.initials("  maya  "), "M");
  assert.equal(r.initials("Anna Maria Lopez"), "AM");
  assert.equal(r.initials(null), "?");
});

test("the form sends trimmed values, blanks as null, and PATCH only what changed", () => {
  const draft = { title: "  Book band ", description: "  ", dueDate: "", assignedMemberId: "" };
  assert.deepEqual(r.inputOf(draft), { title: "Book band", description: null, dueDate: null, assignedMemberId: null });

  const saved = task("4", { title: "Book band", dueDate: "2027-01-10", assignee: member("7") });
  assert.deepEqual(r.changedFields(saved, r.draftOf(saved)), {});
  assert.deepEqual(r.changedFields(saved, { ...r.draftOf(saved), dueDate: "", assignedMemberId: "8" }),
    { dueDate: null, assignedMemberId: "8" });
});

test("draftErrors matches the API's title and description rules", () => {
  assert.equal(r.draftErrors({ title: " ", description: "", dueDate: "", assignedMemberId: "" }).title, "Task name is required");
  assert.equal(r.draftErrors({ title: "x".repeat(201), description: "", dueDate: "", assignedMemberId: "" }).title,
    "Keep this under 200 characters");
  assert.deepEqual(r.draftErrors({ title: "Ok", description: "x".repeat(2000), dueDate: "", assignedMemberId: "" }), {});
});
