// Task routes in the shared RouteDef shape.
// Paths must match the API Gateway resource paths exactly.
// Each route checks event membership before doing anything else, so a non-member
// never learns whether a task ID exists.
import { ApiError } from "../../expense-service/errors";
import { idParam, type RouteDef } from "../../shared/http/routes";
import { findMembership } from "../repositories/taskRepository";
import * as tasks from "../services/taskService";
import type { MemberRole } from "../types";

export const LIST = "/events/{eventId}/tasks";
export const ONE = "/events/{eventId}/tasks/{taskId}";
export const FROM_TEMPLATE = `${LIST}/from-template`;

/**
 * Like requireMember, but also returns the role (delete is owner-only).
 * 403 for non-members and for missing events alike.
 */
async function member(rawEventId: string | undefined, sub: string): Promise<{ eventId: string; role: MemberRole }> {
  const eventId = idParam(rawEventId);
  const m = eventId === null ? null : await findMembership(eventId, sub);
  if (!eventId || !m) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
  return { eventId, role: m.role };
}

export const taskRoutes: RouteDef[] = [
  {
    method: "GET", path: LIST,
    async handle({ params, sub }) {
      const { eventId } = await member(params.eventId, sub);
      return { status: 200, body: await tasks.listTasks(eventId) };
    },
  },
  {
    method: "POST", path: LIST,
    async handle({ params, sub, body }) {
      const { eventId } = await member(params.eventId, sub);
      return { status: 201, body: await tasks.createTask(eventId, body) };
    },
  },
  {
    method: "POST", path: FROM_TEMPLATE,
    async handle({ params, sub }) {
      const { eventId } = await member(params.eventId, sub);
      return { status: 201, body: await tasks.generateFromTemplate(eventId) };
    },
  },
  {
    method: "GET", path: ONE,
    async handle({ params, sub }) {
      const { eventId } = await member(params.eventId, sub);
      return { status: 200, body: await tasks.getTask(eventId, idParam(params.taskId)) };
    },
  },
  {
    method: "PATCH", path: ONE,
    async handle({ params, sub, body }) {
      const { eventId } = await member(params.eventId, sub);
      return { status: 200, body: await tasks.updateTask(eventId, idParam(params.taskId), body) };
    },
  },
  {
    method: "DELETE", path: ONE,
    async handle({ params, sub }) {
      const { eventId, role } = await member(params.eventId, sub);
      if (role !== "OWNER") throw new ApiError(403, "OWNER_REQUIRED", "Only the event owner can delete tasks.");
      await tasks.deleteTask(eventId, idParam(params.taskId));
      return { status: 204 };
    },
  },
];
