// Pure task helpers for the Tasks page. No imports, so scripts/tasks.test.mjs can load it.
//
// Overdue and "due this week" are worked out here, from the user's LOCAL date: the server
// runs in UTC and doesn't know the user's time zone (docs/api/tasks.md).
// Due dates are YYYY-MM-DD strings, so plain string comparison orders them correctly.

interface TaskLike {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  isCompleted: boolean;
  assignee: { memberId: string; displayName: string | null; role: "OWNER" | "CO_PLANNER" } | null;
}

export type TaskTab = "all" | "open" | "done";
/** "all", "me", "none" (unassigned) or a member_id. */
export type AssigneeFilter = string;

/** Today as YYYY-MM-DD in the browser's time zone. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** YYYY-MM-DD plus n days (calendar arithmetic in UTC, so no DST surprises). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isOverdue(task: TaskLike, today: string): boolean {
  return !task.isCompleted && task.dueDate !== null && task.dueDate < today;
}

/** Open and due today or in the next 6 days (7 days in all). Overdue tasks don't count. */
export function isDueThisWeek(task: TaskLike, today: string): boolean {
  return !task.isCompleted && task.dueDate !== null && task.dueDate >= today && task.dueDate <= addDays(today, 6);
}

/** Same rounding as the API and the dashboard: 0 tasks is 0%. */
export function progressOf(tasks: TaskLike[]) {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.isCompleted).length;
  return { total, completed, open: total - completed, percentComplete: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

/** The API's order: open first, then by due date (undated last), then oldest first. */
export function sortTasks<T extends TaskLike>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    // IDs are whole numbers as text: a shorter one is smaller, same length compares as text.
    return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/** Replace one task in the list (after a save) and keep the API's order. */
export function replaceTask<T extends TaskLike>(tasks: T[], task: T): T[] {
  return sortTasks(tasks.some((t) => t.id === task.id) ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task]);
}

export function filterTasks<T extends TaskLike>(tasks: T[], tab: TaskTab, assignee: AssigneeFilter, myMemberId: string | null): T[] {
  return tasks.filter((t) => {
    if (tab === "open" && t.isCompleted) return false;
    if (tab === "done" && !t.isCompleted) return false;
    if (assignee === "all") return true;
    if (assignee === "none") return t.assignee === null;
    const wanted = assignee === "me" ? myMemberId : assignee;
    return wanted !== null && t.assignee?.memberId === wanted;
  });
}

/** "Min Baker" -> "MB", null -> "?" (a member who hasn't set a name). */
export function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

export interface TaskDraft {
  title: string;
  description: string;
  dueDate: string;
  assignedMemberId: string;
}

export function draftOf(task: TaskLike | null): TaskDraft {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    dueDate: task?.dueDate ?? "",
    assignedMemberId: task?.assignee?.memberId ?? "",
  };
}

/** The form's values as API fields: blank text becomes null. */
export function inputOf(draft: TaskDraft) {
  const text = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    title: draft.title.trim(),
    description: text(draft.description),
    dueDate: draft.dueDate === "" ? null : draft.dueDate,
    assignedMemberId: draft.assignedMemberId === "" ? null : draft.assignedMemberId,
  };
}

/** Only the fields that differ from the task, for PATCH. Empty when nothing changed. */
export function changedFields(task: TaskLike, draft: TaskDraft): Partial<ReturnType<typeof inputOf>> {
  const next = inputOf(draft);
  const current = { title: task.title, description: task.description, dueDate: task.dueDate, assignedMemberId: task.assignee?.memberId ?? null };
  const changes: Partial<ReturnType<typeof inputOf>> = {};
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (next[key] !== current[key]) (changes as Record<string, unknown>)[key] = next[key];
  }
  return changes;
}

/** Client-side checks that match the API's messages. The API checks again. */
export function draftErrors(draft: TaskDraft): Partial<Record<keyof TaskDraft, string>> {
  const errors: Partial<Record<keyof TaskDraft, string>> = {};
  const title = draft.title.trim();
  if (!title) errors.title = "Task name is required";
  else if (title.length > 200) errors.title = "Keep this under 200 characters";
  if (draft.description.trim().length > 2000) errors.description = "Keep this under 2000 characters";
  return errors;
}
