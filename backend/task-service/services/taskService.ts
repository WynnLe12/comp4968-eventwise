// What each task route does: validate, write in a transaction, read back.
// Throws ApiError for every expected failure
// The caller (taskRoutes.ts) has already checked that the user is on the event.
import type { PoolConnection } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { getDatabasePool } from "../../shared/db/pool";
import * as repo from "../repositories/taskRepository";
import { NEW_TASK, type FieldErrors, type TaskDraft, type TaskFields } from "../types";
import { toProgress } from "./progress";
import { editableFields, toTask, type Task } from "./taskMapper";
import { cleanInput, NOT_ON_TEAM, validateFields } from "./validation";

const invalid = (fields: FieldErrors) =>
  new ApiError(422, "VALIDATION_ERROR", "Check the submitted fields.", fields as Record<string, string>);
const notFound = () => new ApiError(404, "NOT_FOUND", "Task not found.");
const notOnTeam = () => invalid({ assignedMemberId: NOT_ON_TEAM });

/** Merge the body onto the current fields, then validate. 422 with every field problem. */
function prepare(current: TaskDraft | TaskFields, body: unknown): TaskFields {
  const draft = { ...current, ...cleanInput(body) } as TaskDraft;
  const fields = validateFields(draft);
  if (Object.keys(fields).length) throw invalid(fields);
  return draft as unknown as TaskFields;
}

/** Runs fn in a transaction. Rolls back on any error. */
async function inTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getDatabasePool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * 422 unless the assignee is on this event. Inside the transaction, so the member row
 * stays locked until the write commits (see assigneeInEvent).
 */
async function checkAssignee(conn: PoolConnection, eventId: string, memberId: string | null): Promise<void> {
  if (memberId !== null && !(await repo.assigneeInEvent(conn, eventId, memberId))) throw notOnTeam();
}

/** Every task of the event, plus progress counted from the same rows. */
export async function listTasks(eventId: string): Promise<{ tasks: Task[]; progress: ReturnType<typeof toProgress> }> {
  const tasks = (await repo.listTasks(eventId)).map(toTask);
  return { tasks, progress: toProgress(tasks.length, tasks.filter((t) => t.isCompleted).length) };
}

/** @param taskId null when the path ID isn't a valid ID: that's a 404 too. */
export async function getTask(eventId: string, taskId: string | null): Promise<Task> {
  const row = taskId === null ? null : await repo.findTask(eventId, taskId);
  if (!row) throw notFound();
  return toTask(row);
}

export async function createTask(eventId: string, body: unknown): Promise<Task> {
  const task = prepare(NEW_TASK, body);
  return inTransaction(async (conn) => {
    await checkAssignee(conn, eventId, task.assignedMemberId);
    const id = await repo.insertTask(conn, eventId, task);
    return toTask((await repo.findTask(eventId, id, conn))!);
  });
}

export async function updateTask(eventId: string, taskId: string | null, body: unknown): Promise<Task> {
  const current = await getTask(eventId, taskId); // 404 first, before any validation
  const next = prepare(editableFields(current), body);
  return inTransaction(async (conn) => {
    // Checked even when unchanged: the lock keeps the assignee from being removed mid-update.
    await checkAssignee(conn, eventId, next.assignedMemberId);
    await repo.updateTask(conn, eventId, current.id, next);
    const row = await repo.findTask(eventId, current.id, conn);
    if (!row) throw notFound(); // deleted between the read and the write
    return toTask(row);
  });
}

export async function deleteTask(eventId: string, taskId: string | null): Promise<void> {
  const current = await getTask(eventId, taskId); // 404 if it isn't in this event
  await repo.deleteTask(eventId, current.id);
}

export async function generateFromTemplate(eventId: string): Promise<{ created: number; tasks: Task[] }> {
  const { hasTemplate, created } = await repo.insertFromTemplate(eventId);
  if (!hasTemplate) throw new ApiError(409, "NO_TEMPLATE", "This event wasn't created from a template.");
  return { created, tasks: (await repo.listTasks(eventId)).map(toTask) };
}
