/**
 * Task service backed by the Tasks API (docs/api/tasks.md), which reads and writes the
 * tasks table in RDS through the eventwise-tasks Lambda.
 *
 * Same conventions as vendorService.ts: every request sends the Cognito access token as
 * `Authorization: Bearer <token>`, and error bodies `{ error: { code, message, fields? } }`
 * become the error classes below.
 */
import { requireAuthSession } from "../features/auth/services/authService";
import type { Task, TaskFieldErrors, TaskInput, TaskList } from "../types";
import { apiUrl } from "./apiConfig";

/** Any non-2xx response. `code` is the API's `error.code` (absent for API Gateway's 401). */
export class TaskServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "TaskServiceError";
  }
}

/** 422 VALIDATION_ERROR: `fields` maps each invalid field to the message shown under it. */
export class TaskValidationError extends TaskServiceError {
  constructor(
    message: string,
    public readonly fields: TaskFieldErrors,
  ) {
    super(message, 422, "VALIDATION_ERROR");
    this.name = "TaskValidationError";
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; fields?: TaskFieldErrors };
}

/** Friendlier text for statuses whose server message is terse or missing. */
const STATUS_MESSAGES: Record<number, string> = {
  401: "Your session has expired. Please sign in again.",
  403: "You don't have access to this event.",
  404: "This task no longer exists.",
  500: "Something went wrong. Please try again.",
};

async function accessToken(): Promise<string> {
  try {
    const { session } = await requireAuthSession();
    const token = session.tokens?.accessToken;
    if (token) return token.toString();
  } catch {
    // Fall through to the same 401 the API would return.
  }
  throw new TaskServiceError(STATUS_MESSAGES[401]!, 401);
}

/** Path segments are numeric IDs. Encode anyway so a bad value can't change the route. */
function tasksPath(eventId: string, rest = "") {
  return `/events/${encodeURIComponent(eventId)}/tasks${rest}`;
}
const onePath = (eventId: string, taskId: string) => tasksPath(eventId, `/${encodeURIComponent(taskId)}`);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new TaskServiceError("We couldn't reach the server. Check your connection and try again.", 0);
  }

  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return json as T;

  const error = (json as ApiErrorBody | null)?.error ?? {};
  // OWNER_REQUIRED and NO_TEMPLATE carry a message written for the user.
  const useServerMessage =
    response.status === 422 || response.status === 409 || error.code === "OWNER_REQUIRED";
  const message = useServerMessage && error.message
    ? error.message
    : (STATUS_MESSAGES[response.status] ?? error.message ?? STATUS_MESSAGES[500]!);

  if (response.status === 422) throw new TaskValidationError(message, error.fields ?? {});
  throw new TaskServiceError(message, response.status, error.code);
}

/** GET /events/{eventId}/tasks -> 200 { tasks, progress }. Open first, then by due date. */
export const listTasks = (eventId: string) => request<TaskList>("GET", tasksPath(eventId));

/** POST /events/{eventId}/tasks -> 201. Only `title` is required. */
export const createTask = (eventId: string, input: Partial<TaskInput> & { title: string }) =>
  request<Task>("POST", tasksPath(eventId), input);

/** PATCH /events/{eventId}/tasks/{taskId} -> 200. Send only the fields that change. */
export const updateTask = (eventId: string, taskId: string, changes: Partial<TaskInput>) =>
  request<Task>("PATCH", onePath(eventId, taskId), changes);

/** Complete or reopen: a PATCH with only isCompleted. */
export const setTaskCompleted = (eventId: string, taskId: string, done: boolean) =>
  updateTask(eventId, taskId, { isCompleted: done });

/** DELETE /events/{eventId}/tasks/{taskId} -> 204. Owner only (403 OWNER_REQUIRED). */
export const deleteTask = (eventId: string, taskId: string) =>
  request<void>("DELETE", onePath(eventId, taskId));

/** POST /events/{eventId}/tasks/from-template -> 201. Safe to call twice (created: 0). */
export const generateTasksFromTemplate = (eventId: string) =>
  request<{ created: number; tasks: Task[] }>("POST", tasksPath(eventId, "/from-template"));
