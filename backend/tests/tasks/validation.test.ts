import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanInput, MAX_LENGTH, NOT_ON_TEAM, validateFields } from "../../task-service/services/validation";
import { NEW_TASK, type TaskDraft } from "../../task-service/types";

/** Validate a new task built from a request body, as POST does. */
const check = (body: Record<string, unknown>) =>
  validateFields({ ...NEW_TASK, ...cleanInput(body) } as TaskDraft);

test("a title alone is a valid task", () => {
  assert.deepEqual(check({ title: "Book the venue" }), {});
});

test("title is required, trimmed and at most 200 characters", () => {
  assert.equal(check({}).title, "Task name is required");
  assert.equal(check({ title: "   " }).title, "Task name is required");
  assert.equal(check({ title: 7 }).title, "Enter text");
  assert.equal(check({ title: "x".repeat(MAX_LENGTH.title + 1) }).title, "Keep this under 200 characters");
  assert.deepEqual(check({ title: "x".repeat(MAX_LENGTH.title) }), {});
  assert.equal(cleanInput({ title: "  Send invites  " }).title, "Send invites");
});

test("description is optional text up to 2000 characters, and blank becomes null", () => {
  assert.equal(cleanInput({ description: "  " }).description, null);
  assert.deepEqual(check({ title: "T", description: null }), {});
  assert.equal(check({ title: "T", description: ["x"] }).description, "Enter text");
  assert.equal(check({ title: "T", description: "x".repeat(2001) }).description, "Keep this under 2000 characters");
  assert.deepEqual(check({ title: "T", description: "x".repeat(2000) }), {});
});

test("dueDate must be a real YYYY-MM-DD date or null", () => {
  for (const dueDate of ["2027-02-30", "02/03/2027", "2027-1-5", 20270105]) {
    assert.equal(check({ title: "T", dueDate }).dueDate, "Enter a valid date", String(dueDate));
  }
  assert.deepEqual(check({ title: "T", dueDate: null }), {});
  assert.deepEqual(check({ title: "T", dueDate: "" }), {});
  assert.deepEqual(check({ title: "T", dueDate: "2028-02-29" }), {});
});

test("assignedMemberId must be a positive ID, and a number becomes text", () => {
  for (const assignedMemberId of ["abc", "0", -1, 1.5, "-3", true]) {
    assert.equal(check({ title: "T", assignedMemberId }).assignedMemberId, NOT_ON_TEAM, String(assignedMemberId));
  }
  assert.equal(cleanInput({ assignedMemberId: 3 }).assignedMemberId, "3");
  assert.deepEqual(check({ title: "T", assignedMemberId: 3 }), {});
  assert.deepEqual(check({ title: "T", assignedMemberId: null }), {});
});

test("isCompleted must be a boolean", () => {
  assert.equal(check({ title: "T", isCompleted: "true" }).isCompleted, "Must be true or false");
  assert.equal(check({ title: "T", isCompleted: 1 }).isCompleted, "Must be true or false");
  assert.equal(check({ title: "T", isCompleted: null }).isCompleted, "Must be true or false");
  assert.deepEqual(check({ title: "T", isCompleted: true }), {});
});

test("unknown and read-only keys are ignored", () => {
  assert.deepEqual(
    cleanInput({ title: "T", id: "9", eventId: "2", completedAt: "2026-01-01T00:00:00Z", source: "TEMPLATE", extra: 1 }),
    { title: "T" },
  );
  assert.deepEqual(cleanInput(null), {});
  assert.deepEqual(cleanInput(["title"]), {});
  assert.deepEqual(cleanInput("title"), {});
});

test("every invalid field is reported at once", () => {
  assert.deepEqual(Object.keys(check({ dueDate: "nope", assignedMemberId: "x", isCompleted: "no" })).sort(),
    ["assignedMemberId", "dueDate", "isCompleted", "title"]);
});
