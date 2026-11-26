// All the task SQL. Every query filters by event_id, so a task ID from another event
// never matches. Values always go through ? placeholders, never string-built SQL.
// The shared pool returns BIGINTs and COUNT/SUM as strings, BOOLEAN as 0/1, and dates as text.
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDatabasePool } from "../../shared/db/pool";
import type { MemberRole, TaskFields } from "../types";

/** A pool or a transaction's connection. */
export type Exec = Pick<PoolConnection, "execute">;

/** A tasks row joined with its assignee, as the shared pool returns it. */
export interface TaskRow extends RowDataPacket {
  task_id: string;
  event_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  is_completed: number;
  completed_at: string | null;
  assigned_member_id: string | null;
  assignee_role: MemberRole | null;
  assignee_display_name: string | null;
  template_task_id: string | null;
  created_at: string;
  updated_at: string;
}

// The join also checks the event, so an assignee from another event never shows.
const SELECT = `
  SELECT t.task_id, t.event_id, t.title, t.description, t.due_date, t.is_completed, t.completed_at,
         t.assigned_member_id, m.role AS assignee_role, m.display_name AS assignee_display_name,
         t.template_task_id, t.created_at, t.updated_at
  FROM tasks t
  LEFT JOIN event_members m ON m.member_id = t.assigned_member_id AND m.event_id = t.event_id
  WHERE t.event_id = ?`;

// Open first, then by due date (undated last), then oldest first.
const ORDER = " ORDER BY t.is_completed, t.due_date IS NULL, t.due_date, t.task_id";

/**
 * The caller's member_id and role, or null if they aren't on the event.
 * The BINARY comparison makes the sub match exactly: the column's collation ignores case.
 */
export async function findMembership(eventId: string, sub: string): Promise<{ member_id: string; role: MemberRole } | null> {
  const [rows] = await getDatabasePool().execute<RowDataPacket[]>(
    `SELECT member_id, role FROM event_members
     WHERE event_id = ? AND cognito_sub = ? AND CAST(cognito_sub AS BINARY) = CAST(? AS BINARY) LIMIT 1`,
    [eventId, sub, sub],
  );
  return (rows[0] as { member_id: string; role: MemberRole } | undefined) ?? null;
}

/**
 * Whether memberId is on this event. FOR SHARE holds the member row until commit, so
 * co-planner removal (which takes FOR UPDATE on it) waits instead of racing the assignment.
 * Must run inside a transaction.
 */
export async function assigneeInEvent(conn: Exec, eventId: string, memberId: string): Promise<boolean> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    "SELECT 1 FROM event_members WHERE member_id = ? AND event_id = ? FOR SHARE",
    [memberId, eventId],
  );
  return rows.length > 0;
}

export async function listTasks(eventId: string): Promise<TaskRow[]> {
  const [rows] = await getDatabasePool().execute<TaskRow[]>(SELECT + ORDER, [eventId]);
  return rows;
}

/** One task, or null if it doesn't exist in this event. */
export async function findTask(eventId: string, taskId: string, conn: Exec = getDatabasePool()): Promise<TaskRow | null> {
  const [rows] = await conn.execute<TaskRow[]>(`${SELECT} AND t.task_id = ?`, [eventId, taskId]);
  return rows[0] ?? null;
}

/** Returns the new task's ID. completed_at is set by the database when it starts completed. */
export async function insertTask(conn: Exec, eventId: string, t: TaskFields): Promise<string> {
  const [result] = await conn.execute<ResultSetHeader>(
    `INSERT INTO tasks (event_id, title, description, due_date, is_completed, completed_at, assigned_member_id)
     VALUES (?, ?, ?, ?, ?, ${t.isCompleted ? "UTC_TIMESTAMP()" : "NULL"}, ?)`,
    [eventId, t.title, t.description, t.dueDate, t.isCompleted, t.assignedMemberId],
  );
  return String(result.insertId);
}

/**
 * completed_at is set only on the false -> true change, cleared on reopen, kept otherwise.
 * MySQL applies SET assignments left to right, so the CASE reads the OLD is_completed.
 * Keep completed_at before is_completed: swapped, completing a task never sets completed_at
 * and chk_task_completed_at rejects the update.
 */
export async function updateTask(conn: Exec, eventId: string, taskId: string, t: TaskFields): Promise<void> {
  await conn.execute(
    `UPDATE tasks SET title = ?, description = ?, due_date = ?, assigned_member_id = ?,
       completed_at = CASE WHEN ? = FALSE THEN NULL
                           WHEN is_completed = FALSE THEN UTC_TIMESTAMP()
                           ELSE completed_at END,
       is_completed = ?
     WHERE task_id = ? AND event_id = ?`,
    [t.title, t.description, t.dueDate, t.assignedMemberId, t.isCompleted, t.isCompleted, taskId, eventId],
  );
}

export async function deleteTask(eventId: string, taskId: string): Promise<void> {
  await getDatabasePool().execute("DELETE FROM tasks WHERE task_id = ? AND event_id = ?", [taskId, eventId]);
}

/**
 * Copies the event's template tasks as ordinary, editable rows.
 * INSERT IGNORE + uq_task_template makes it safe to run twice (or two at once).
 * Due date = event_date - days_before_event (NULL if either is NULL).
 */
export async function insertFromTemplate(eventId: string): Promise<{ hasTemplate: boolean; created: number }> {
  const pool = getDatabasePool();
  const [events] = await pool.execute<RowDataPacket[]>("SELECT template_id FROM events WHERE event_id = ?", [eventId]);
  if (!events[0]?.template_id) return { hasTemplate: false, created: 0 };
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT IGNORE INTO tasks (event_id, title, description, due_date, template_task_id)
     SELECT e.event_id, tt.title, tt.description,
            CASE WHEN e.event_date IS NULL OR tt.days_before_event IS NULL THEN NULL
                 ELSE DATE_SUB(e.event_date, INTERVAL tt.days_before_event DAY) END,
            tt.template_task_id
     FROM events e JOIN template_tasks tt ON tt.template_id = e.template_id
     WHERE e.event_id = ?
     ORDER BY tt.sort_order, tt.template_task_id`,
    [eventId],
  );
  return { hasTemplate: true, created: result.affectedRows };
}
