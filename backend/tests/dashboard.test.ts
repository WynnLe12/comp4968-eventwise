import "./testEnvironment";
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, DashboardService, type DashboardDependencies } from "../event-service/services/dashboardService";
import { EventAccessDeniedError, EventNotFoundError, EventValidationError } from "../event-service/services/eventService";
import type { PaymentRows, TaskRows } from "../event-service/repositories/dashboardRepository";
import type { ExpenseSummary } from "../expense-service/types";
import type { GuestSummary } from "../guest-service/services/guestSummary";

const summary: ExpenseSummary = {
  eventId: "11", asOfDate: "2026-06-10", eventBudget: "5000.00", allocatedBudget: "5000.00",
  unallocatedBudget: "0.00", committedTotal: "2400.00", paidTotal: "850.00", outstandingTotal: "1550.00",
  remainingBudget: "2600.00", isOverBudget: false, overdueTotal: "800.00", dueThisMonthTotal: "1550.00",
  expenseCount: 4, openExpenseCount: 3, dueThisMonthCount: 3,
  categories: [{
    categoryId: "3", categoryName: "Photography", plannedAmount: "3000.00", committedTotal: "1600.00",
    paidTotal: "800.00", outstandingTotal: "800.00", remainingBudget: "1400.00", isOverBudget: false, overdueTotal: "800.00",
  }],
};
const payments: PaymentRows = {
  overdueTotal: "800.00", overdueCount: 1, upcomingTotal: "500.00", upcomingCount: 1,
  items: [{ expenseId: "7", description: "Photographer deposit", vendorName: "Lens Studio", categoryName: "Photography",
    dueDate: "2026-06-05", outstandingAmount: "800.00", isOverdue: true }],
};
const tasks: TaskRows = {
  total: 3, completed: 1, overdue: 1,
  nextDue: [
    { taskId: "21", title: "Send invites", dueDate: "2026-06-05", assigneeDisplayName: "  Heather ", assigneeRole: "CO_PLANNER" },
    { taskId: "22", title: "Confirm florist", dueDate: "2026-06-12", assigneeDisplayName: null, assigneeRole: "OWNER" },
    { taskId: "23", title: "Pick music", dueDate: "2026-06-14", assigneeDisplayName: null, assigneeRole: null },
  ],
};
const guests: GuestSummary = {
  records: 3, plusOnes: 1, expectedHeadcount: 4, rsvp: { UNINVITED: 1, PENDING: 0, ACCEPTED: 1, REJECTED: 1 },
};

function setup(overrides: Partial<DashboardDependencies> & { role?: "OWNER" | "CO_PLANNER" | null } = {}) {
  const calls: string[] = [];
  const logged: unknown[] = [];
  const role = "role" in overrides ? overrides.role : "OWNER";
  const deps: DashboardDependencies = {
    repository: {
      eventAccess: async (eventId, sub) => { calls.push(`access:${eventId}:${sub}`); return role; },
      payments: async (eventId, today, until) => { calls.push(`payments:${eventId}:${today}:${until}`); return payments; },
      tasks: async (eventId, today) => { calls.push(`tasks:${eventId}:${today}`); return tasks; },
    },
    expenses: { summary: async (eventId, sub) => { calls.push(`summary:${eventId}:${sub}`); return summary; } },
    guests: async (eventId) => { calls.push(`guests:${eventId}`); return guests; },
    today: () => "2026-06-10",
    logError: (...args) => { logged.push(args); },
    ...overrides,
  };
  return { service: new DashboardService(deps), calls, logged };
}

test("an owner gets every section, built from the expense summary, payments, guests and tasks", async () => {
  const { service, calls } = setup();
  const dashboard = await service.get("11", "owner-sub");
  assert.deepEqual(dashboard, {
    eventId: "11",
    asOfDate: "2026-06-10",
    budget: {
      eventBudget: "5000.00", allocatedBudget: "5000.00", committedTotal: "2400.00", paidTotal: "850.00",
      outstandingTotal: "1550.00", remainingBudget: "2600.00", isOverBudget: false,
      categories: [{ categoryId: "3", categoryName: "Photography", plannedAmount: "3000.00", committedTotal: "1600.00",
        paidTotal: "800.00", remainingBudget: "1400.00", isOverBudget: false }],
    },
    payments: { windowDays: 7, ...payments },
    guests,
    tasks: {
      total: 3, completed: 1, overdue: 1, percentComplete: 33,
      nextDue: [
        { taskId: "21", title: "Send invites", dueDate: "2026-06-05", assigneeName: "Heather" },
        { taskId: "22", title: "Confirm florist", dueDate: "2026-06-12", assigneeName: "Owner" },
        { taskId: "23", title: "Pick music", dueDate: "2026-06-14", assigneeName: null },
      ],
    },
    unavailable: [],
  });
  // Access is checked first; payments cover today + 7 days; the summary keeps its own member check.
  assert.equal(calls[0], "access:11:owner-sub");
  assert.ok(calls.includes("payments:11:2026-06-10:2026-06-17"));
  assert.ok(calls.includes("summary:11:owner-sub"));
});

test("co-planners can see the dashboard too", async () => {
  const { service } = setup({ role: "CO_PLANNER" });
  assert.equal((await service.get("11", "co-sub")).eventId, "11");
});

test("a missing event is 404 and a non-member is 403, before any other data is read", async () => {
  for (const [role, error] of [[undefined, EventNotFoundError], [null, EventAccessDeniedError]] as const) {
    const { service, calls } = setup({ role: role as null });
    await assert.rejects(service.get("11", "someone"), error);
    assert.deepEqual(calls, ["access:11:someone"]);
  }
});

test("an invalid event ID or missing identity is rejected without reading data", async () => {
  for (const id of ["0", "abc", "-1", "18446744073709551616"]) {
    const { service, calls } = setup();
    await assert.rejects(service.get(id, "owner-sub"), EventValidationError);
    assert.equal(calls.length, 0);
  }
  const { service, calls } = setup();
  await assert.rejects(service.get("11", ""), /identity is required/);
  assert.equal(calls.length, 0);
});

test("if guests can't be read, the dashboard still loads and marks guests unavailable", async () => {
  const { service, logged } = setup({ guests: async () => { throw Object.assign(new Error("secret detail"), { name: "ResourceNotFoundException" }); } });
  const dashboard = await service.get("11", "owner-sub");
  assert.equal(dashboard.guests, null);
  assert.deepEqual(dashboard.unavailable, ["guests"]);
  assert.equal(dashboard.tasks.total, 3);
  assert.equal(dashboard.budget.committedTotal, "2400.00");
  // Only the error name is logged, never its message.
  assert.equal(logged.length, 1);
  assert.doesNotMatch(JSON.stringify(logged), /secret detail/);
});

test("a database failure fails the whole request", async () => {
  const { service } = setup({ expenses: { summary: async () => { throw new Error("RDS down"); } } });
  await assert.rejects(service.get("11", "owner-sub"), /RDS down/);
});

test("task progress is 0% with no tasks and rounds to a whole percent", async () => {
  const progress = async (total: number, completed: number) => {
    const { service } = setup({ repository: {
      eventAccess: async () => "OWNER", payments: async () => payments,
      tasks: async () => ({ total, completed, overdue: 0, nextDue: [] }),
    } });
    return (await service.get("11", "owner-sub")).tasks.percentComplete;
  };
  assert.equal(await progress(0, 0), 0);
  assert.equal(await progress(3, 2), 67);
  assert.equal(await progress(4, 4), 100);
});

test("addDays works across month and year ends in UTC", () => {
  assert.equal(addDays("2026-06-10", 7), "2026-06-17");
  assert.equal(addDays("2026-12-28", 7), "2027-01-04");
  assert.equal(addDays("2028-02-25", 7), "2028-03-03");
  assert.throws(() => addDays("not-a-date", 7), /Invalid date/);
});
