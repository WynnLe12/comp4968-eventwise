import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskRow } from "../../task-service/repositories/taskRepository";
import { editableFields, toTask } from "../../task-service/services/taskMapper";

function row(overrides: Record<string, unknown> = {}): TaskRow {
  return {
    task_id: "12", event_id: "1", title: "Book ceremony musicians", description: null,
    due_date: "2027-06-02", is_completed: 0, completed_at: null,
    assigned_member_id: "3", assignee_role: "CO_PLANNER", assignee_display_name: "Min B.",
    template_task_id: "7", created_at: "2026-11-24 18:02:11", updated_at: "2026-11-24 18:05:00",
    ...overrides,
  } as TaskRow;
}

test("maps a row to the contract shape with ISO UTC timestamps", () => {
  assert.deepEqual(toTask(row()), {
    id: "12", eventId: "1", title: "Book ceremony musicians", description: null,
    dueDate: "2027-06-02", isCompleted: false, completedAt: null,
    assignee: { memberId: "3", role: "CO_PLANNER", displayName: "Min B." },
    source: "TEMPLATE", createdAt: "2026-11-24T18:02:11Z", updatedAt: "2026-11-24T18:05:00Z",
  });
});

test("completed tasks get completedAt, manual tasks say MANUAL", () => {
  const task = toTask(row({ is_completed: 1, completed_at: "2026-11-25 09:00:00", template_task_id: null }));
  assert.equal(task.isCompleted, true);
  assert.equal(task.completedAt, "2026-11-25T09:00:00Z");
  assert.equal(task.source, "MANUAL");
});

test("an assignee that isn't on this event (no joined role) shows as unassigned", () => {
  assert.equal(toTask(row({ assignee_role: null, assignee_display_name: null })).assignee, null);
  assert.equal(toTask(row({ assigned_member_id: null, assignee_role: null })).assignee, null);
});

test("editableFields gives the stored values to merge a PATCH onto", () => {
  assert.deepEqual(editableFields(toTask(row())), {
    title: "Book ceremony musicians", description: null, dueDate: "2027-06-02",
    assignedMemberId: "3", isCompleted: false,
  });
});
