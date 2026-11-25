// Field rules for tasks.
import { idParam } from "../../shared/http/routes";
import { validDate } from "../../shared/utils/dateOnly";
import { EDITABLE_FIELDS, type FieldErrors, type TaskDraft } from "../types";

/** title matches VARCHAR(200). description is TEXT, 2000 is our limit. */
export const MAX_LENGTH = { title: 200, description: 2000 } as const;

export const NOT_ON_TEAM = "Choose someone on this event's planning team";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Keep only the editable fields from a request body.
 * - Strings are trimmed, and an empty string becomes null.
 * - A whole-number assignedMemberId becomes text (3 -> "3").
 * - Anything else (id, eventId, completedAt, unknown keys) is ignored.
 * - A body that isn't an object gives no changes.
 */
export function cleanInput(body: unknown): Partial<TaskDraft> {
  const changes: Partial<TaskDraft> = {};
  if (!isObject(body)) return changes;
  for (const key of EDITABLE_FIELDS) {
    if (!Object.hasOwn(body, key)) continue;
    let value = body[key];
    if (typeof value === "string") value = value.trim() || null;
    if (key === "assignedMemberId" && typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
    changes[key] = value;
  }
  return changes;
}

/** Check every field of the task as it will be saved. Returns an empty object when all are valid. */
export function validateFields(t: TaskDraft): FieldErrors {
  const fields: FieldErrors = {};

  if (t.title == null) fields.title = "Task name is required";
  else if (typeof t.title !== "string") fields.title = "Enter text";
  else if (t.title.length > MAX_LENGTH.title) fields.title = `Keep this under ${MAX_LENGTH.title} characters`;

  if (t.description != null) {
    if (typeof t.description !== "string") fields.description = "Enter text";
    else if (t.description.length > MAX_LENGTH.description) {
      fields.description = `Keep this under ${MAX_LENGTH.description} characters`;
    }
  }

  if (t.dueDate != null && !validDate(t.dueDate)) fields.dueDate = "Enter a valid date";

  if (t.assignedMemberId != null &&
      (typeof t.assignedMemberId !== "string" || idParam(t.assignedMemberId) === null)) {
    fields.assignedMemberId = NOT_ON_TEAM;
  }

  if (typeof t.isCompleted !== "boolean") fields.isCompleted = "Must be true or false";

  return fields;
}
