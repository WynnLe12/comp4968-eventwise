// Client for GET /events/{eventId}/dashboard (Feature 10). See docs/api/dashboard.md.
import { apiUrl } from "../../services/apiConfig";
import { getCurrentUser } from "../auth/services/authService";
import { authenticatedEventRequest, EventSessionError, requestEventId } from "../events/services/eventApi";

export const RSVP_KEYS = ["UNINVITED", "PENDING", "ACCEPTED", "REJECTED"] as const;
export type RsvpKey = (typeof RSVP_KEYS)[number];

export interface DashboardCategory {
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  committedTotal: string;
  paidTotal: string;
  remainingBudget: string;
  isOverBudget: boolean;
}

export interface DashboardPayment {
  expenseId: string;
  description: string;
  vendorName: string | null;
  categoryName: string;
  dueDate: string;
  outstandingAmount: string;
  isOverdue: boolean;
}

export interface DashboardTask {
  taskId: string;
  title: string;
  dueDate: string;
  assigneeName: string | null;
}

export interface EventDashboard {
  eventId: string;
  asOfDate: string;
  budget: {
    eventBudget: string;
    allocatedBudget: string;
    committedTotal: string;
    paidTotal: string;
    outstandingTotal: string;
    remainingBudget: string;
    isOverBudget: boolean;
    categories: DashboardCategory[];
  };
  payments: {
    windowDays: number;
    overdueTotal: string;
    overdueCount: number;
    upcomingTotal: string;
    upcomingCount: number;
    items: DashboardPayment[];
  };
  guests: {
    records: number;
    plusOnes: number;
    expectedHeadcount: number;
    rsvp: Record<RsvpKey, number>;
  } | null;
  tasks: {
    total: number;
    completed: number;
    overdue: number;
    percentComplete: number;
    nextDue: DashboardTask[];
  };
  unavailable: string[];
}

export class DashboardError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const loadError = "Unable to load the dashboard. Please try again.";

// --- Response validation: anything unexpected becomes a friendly load error. ---
type Json = Record<string, unknown>;
const invalid = (): never => { throw new DashboardError(502, loadError); };
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : invalid();
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : invalid());
const text = (value: unknown): string => (typeof value === "string" ? value : invalid());
const nullableText = (value: unknown): string | null => (value === null ? null : text(value));
const flag = (value: unknown): boolean => (typeof value === "boolean" ? value : invalid());
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const money = (value: unknown): string =>
  typeof value === "string" && /^-?[0-9]{1,13}\.[0-9]{2}$/.test(value) ? value : invalid();
const date = (value: unknown): string =>
  typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ? value : invalid();

/** Checks the response against the API contract and keeps only the documented fields. */
export function parseDashboard(body: unknown): EventDashboard {
  const root = object(body);
  const budget = object(root.budget);
  const payments = object(root.payments);
  const tasks = object(root.tasks);
  const guests = root.guests === null ? null : object(root.guests);
  const rsvp = guests && object(guests.rsvp);
  return {
    eventId: text(root.eventId),
    asOfDate: date(root.asOfDate),
    budget: {
      eventBudget: money(budget.eventBudget),
      allocatedBudget: money(budget.allocatedBudget),
      committedTotal: money(budget.committedTotal),
      paidTotal: money(budget.paidTotal),
      outstandingTotal: money(budget.outstandingTotal),
      remainingBudget: money(budget.remainingBudget),
      isOverBudget: flag(budget.isOverBudget),
      categories: list(budget.categories).map((item) => {
        const category = object(item);
        return {
          categoryId: text(category.categoryId),
          categoryName: text(category.categoryName),
          plannedAmount: money(category.plannedAmount),
          committedTotal: money(category.committedTotal),
          paidTotal: money(category.paidTotal),
          remainingBudget: money(category.remainingBudget),
          isOverBudget: flag(category.isOverBudget),
        };
      }),
    },
    payments: {
      windowDays: count(payments.windowDays),
      overdueTotal: money(payments.overdueTotal),
      overdueCount: count(payments.overdueCount),
      upcomingTotal: money(payments.upcomingTotal),
      upcomingCount: count(payments.upcomingCount),
      items: list(payments.items).map((item) => {
        const payment = object(item);
        return {
          expenseId: text(payment.expenseId),
          description: text(payment.description),
          vendorName: nullableText(payment.vendorName),
          categoryName: text(payment.categoryName),
          dueDate: date(payment.dueDate),
          outstandingAmount: money(payment.outstandingAmount),
          isOverdue: flag(payment.isOverdue),
        };
      }),
    },
    guests: guests && rsvp && {
      records: count(guests.records),
      plusOnes: count(guests.plusOnes),
      expectedHeadcount: count(guests.expectedHeadcount),
      rsvp: Object.fromEntries(RSVP_KEYS.map((key) => [key, count(rsvp[key])])) as Record<RsvpKey, number>,
    },
    tasks: {
      total: count(tasks.total),
      completed: count(tasks.completed),
      overdue: count(tasks.overdue),
      percentComplete: count(tasks.percentComplete),
      nextDue: list(tasks.nextDue).map((item) => {
        const task = object(item);
        return {
          taskId: text(task.taskId),
          title: text(task.title),
          dueDate: date(task.dueDate),
          assigneeName: nullableText(task.assigneeName),
        };
      }),
    },
    unavailable: list(root.unavailable).map(text),
  };
}

/** Loads the dashboard of one event for the signed-in organizer. */
export async function getDashboard(eventId: string, signal?: AbortSignal): Promise<EventDashboard> {
  let id: string;
  try { id = requestEventId(eventId); }
  catch { throw new DashboardError(400, "Select a valid event."); }
  const identity = await authenticatedEventRequest();
  let response: Response;
  try {
    response = await fetch(apiUrl(`/events/${id}/dashboard`), {
      headers: { Authorization: `Bearer ${identity.token.toString()}` }, signal,
    });
  } catch {
    signal?.throwIfAborted();
    throw new DashboardError(0, loadError);
  }
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (response.status === 403) throw new DashboardError(403, "You no longer have access to this event. Select another event or refresh your event list.");
  if (response.status === 404) throw new DashboardError(404, "This event no longer exists. Select another event or refresh your event list.");
  if (!response.ok) throw new DashboardError(response.status, loadError);
  const dashboard = parseDashboard(await response.json().catch(() => invalid()));
  if (dashboard.eventId !== id) invalid();
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  if (current.userId !== identity.user.userId) throw new DashboardError(409, "Your account changed. Please reload your events.");
  return dashboard;
}

/** "1234.50" -> "$1,234.50" (same digits format as the Budget page). */
export function formatMoney(amount: string): string {
  const value = Number(amount);
  const formatted = Math.abs(value).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? "-" : ""}$${formatted}`;
}
