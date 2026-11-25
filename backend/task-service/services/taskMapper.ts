// Database row -> API JSON 
import type { TaskRow } from "../repositories/taskRepository";
import type { MemberRole, TaskFields } from "../types";

/** "2026-11-24 18:02:11" (UTC, from dateStrings) -> "2026-11-24T18:02:11Z". */
const iso = (ts: string) => `${ts.replace(" ", "T")}Z`;

export interface Task {
  id: string;
  eventId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  isCompleted: boolean;
  completedAt: string | null;
  assignee: { memberId: string; role: MemberRole; displayName: string | null } | null;
  /** TEMPLATE stays after edits: it says where the task came from, nothing more. */
  source: "MANUAL" | "TEMPLATE";
  createdAt: string;
  updatedAt: string;
}

export function toTask(r: TaskRow): Task {
  return {
    id: String(r.task_id),
    eventId: String(r.event_id),
    title: r.title,
    description: r.description,
    dueDate: r.due_date,
    isCompleted: Boolean(r.is_completed),
    completedAt: r.completed_at ? iso(r.completed_at) : null,
    assignee: r.assigned_member_id && r.assignee_role
      ? { memberId: String(r.assigned_member_id), role: r.assignee_role, displayName: r.assignee_display_name }
      : null,
    source: r.template_task_id ? "TEMPLATE" : "MANUAL",
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** The stored editable fields of a task, to merge a PATCH body onto. */
export function editableFields(t: Task): TaskFields {
  return {
    title: t.title,
    description: t.description,
    dueDate: t.dueDate,
    assignedMemberId: t.assignee?.memberId ?? null,
    isCompleted: t.isCompleted,
  };
}
