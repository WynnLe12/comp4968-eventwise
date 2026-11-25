// Task types

/** The only fields a client may send. Everything else in a body is ignored. */
export const EDITABLE_FIELDS = ["title", "description", "dueDate", "assignedMemberId", "isCompleted"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type MemberRole = "OWNER" | "CO_PLANNER";

/** A task's stored, editable fields after validation. */
export interface TaskFields {
  title: string;
  description: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  /** event_members.member_id (BIGINT as text) */
  assignedMemberId: string | null;
  isCompleted: boolean;
}

/** Editable fields before validation: values can be anything a client sent. */
export type TaskDraft = Record<EditableField, unknown>;
export type FieldErrors = Partial<Record<EditableField, string>>;

/** Defaults for POST: everything but the title is optional. */
export const NEW_TASK: TaskDraft = {
  title: null, description: null, dueDate: null, assignedMemberId: null, isCompleted: false,
};

export interface Progress {
  total: number;
  completed: number;
  open: number;
  percentComplete: number;
}
