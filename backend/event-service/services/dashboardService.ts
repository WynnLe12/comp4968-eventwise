// Event dashboard (Feature 10): budget vs. actual, upcoming payments, guests and tasks
// for one event. Response shape and rules: docs/api/dashboard.md.

import { ExpenseService } from "../../expense-service/services/expenses";
import { MySqlExpenseRepository } from "../../expense-service/repositories/mysql-expenses";
import type { ExpenseSummary } from "../../expense-service/types";
import { loadGuestSummary, type GuestSummary } from "../../guest-service/services/guestSummary";
import { normalizeProfileDisplayName } from "../../shared/auth/profileDisplayName";
import { DashboardRepository, type MemberRole, type PaymentItemRow } from "../repositories/dashboardRepository";
import { EventAccessDeniedError, EventNotFoundError, validateEventId } from "./eventService";

/** Upcoming payments window, shared with Feature 9 payment alerts. */
export const UPCOMING_PAYMENT_DAYS = 7;

export interface DashboardCategory {
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  committedTotal: string;
  paidTotal: string;
  remainingBudget: string;
  isOverBudget: boolean;
}

export interface DashboardTask {
  taskId: string;
  title: string;
  dueDate: string;
  assigneeName: string | null;
}

export interface Dashboard {
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
    items: PaymentItemRow[];
  };
  guests: GuestSummary | null;
  tasks: {
    total: number;
    completed: number;
    overdue: number;
    percentComplete: number;
    nextDue: DashboardTask[];
  };
  /** Sections that could not be loaded (only "guests" today). */
  unavailable: "guests"[];
}

export interface DashboardDependencies {
  repository: Pick<DashboardRepository, "eventAccess" | "payments" | "tasks">;
  expenses: Pick<ExpenseService, "summary">;
  guests: (eventId: string) => Promise<GuestSummary>;
  /** Today's UTC date (YYYY-MM-DD), the same clock as the expense summary. */
  today: () => string;
  logError: (message: string, error: unknown) => void;
}

/** Adds whole days to a YYYY-MM-DD date in UTC. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf())) throw new Error(`Invalid date: ${date}`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Same naming rule as the Planning Team page; null when the task has no valid assignee. */
function assigneeName(displayName: string | null, role: MemberRole | null): string | null {
  if (role === null) return null;
  return normalizeProfileDisplayName(displayName) ?? (role === "OWNER" ? "Owner" : "Co-planner");
}

function budgetSection(summary: ExpenseSummary): Dashboard["budget"] {
  return {
    eventBudget: summary.eventBudget,
    allocatedBudget: summary.allocatedBudget,
    committedTotal: summary.committedTotal,
    paidTotal: summary.paidTotal,
    outstandingTotal: summary.outstandingTotal,
    remainingBudget: summary.remainingBudget,
    isOverBudget: summary.isOverBudget,
    categories: summary.categories.map((category) => ({
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      plannedAmount: category.plannedAmount,
      committedTotal: category.committedTotal,
      paidTotal: category.paidTotal,
      remainingBudget: category.remainingBudget,
      isOverBudget: category.isOverBudget,
    })),
  };
}

export class DashboardService {
  private readonly deps: DashboardDependencies;

  constructor(dependencies: Partial<DashboardDependencies> = {}) {
    this.deps = {
      repository: dependencies.repository ?? new DashboardRepository(),
      expenses: dependencies.expenses ?? new ExpenseService(new MySqlExpenseRepository()),
      guests: dependencies.guests ?? ((eventId) => loadGuestSummary(eventId)),
      today: dependencies.today ?? (() => new Date().toISOString().slice(0, 10)),
      logError: dependencies.logError ?? ((message, error) => console.error(message, error)),
    };
  }

  /** Owners and co-planners only. A missing event is 404, a non-member 403. */
  async get(eventId: string, cognitoSub: string): Promise<Dashboard> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    const id = validateEventId(eventId);
    const { repository, expenses, guests, today, logError } = this.deps;

    const role = await repository.eventAccess(id, cognitoSub);
    if (role === undefined) throw new EventNotFoundError("Event not found");
    if (role === null) throw new EventAccessDeniedError("You do not have access to this event");

    const asOfDate = today();
    const until = addDays(asOfDate, UPCOMING_PAYMENT_DAYS);
    // Guests live in DynamoDB: if they can't be read, the rest of the dashboard still loads.
    const guestSummary = guests(id).catch((error: unknown) => {
      logError(`Dashboard for event ${id} could not load guests:`, error instanceof Error ? error.name : "UnknownError");
      return null;
    });
    const [summary, payments, tasks, guestResult] = await Promise.all([
      expenses.summary(id, cognitoSub),
      repository.payments(id, asOfDate, until),
      repository.tasks(id, asOfDate),
      guestSummary,
    ]);

    return {
      eventId: id,
      asOfDate,
      budget: budgetSection(summary),
      payments: { windowDays: UPCOMING_PAYMENT_DAYS, ...payments },
      guests: guestResult,
      tasks: {
        total: tasks.total,
        completed: tasks.completed,
        overdue: tasks.overdue,
        percentComplete: tasks.total === 0 ? 0 : Math.round((tasks.completed / tasks.total) * 100),
        nextDue: tasks.nextDue.map((task) => ({
          taskId: task.taskId,
          title: task.title,
          dueDate: task.dueDate,
          assigneeName: assigneeName(task.assigneeDisplayName, task.assigneeRole),
        })),
      },
      unavailable: guestResult === null ? ["guests"] : [],
    };
  }
}
