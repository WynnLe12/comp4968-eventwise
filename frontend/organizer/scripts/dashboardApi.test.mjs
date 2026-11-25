import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

class EventSessionError extends Error {}
let currentUser = "user-1";
const requests = [];

function load() {
  const source = readFileSync(new URL("../src/features/dashboard/dashboardApi.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const imports = {
    "../../services/apiConfig": { apiUrl: (path) => `/api${path}` },
    "../auth/services/authService": { getCurrentUser: async () => ({ userId: currentUser }) },
    "../events/services/eventApi": {
      EventSessionError,
      authenticatedEventRequest: async () => ({ user: { userId: "user-1" }, token: { toString: () => "access-token" } }),
      requestEventId: (id) => {
        if (!/^[1-9][0-9]*$/.test(id)) throw new Error("bad id");
        return id;
      },
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)((name) => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const api = load();

const body = () => ({
  eventId: "11",
  asOfDate: "2026-06-10",
  budget: {
    eventBudget: "5000.00", allocatedBudget: "3000.00", committedTotal: "1400.00", paidTotal: "200.00",
    outstandingTotal: "1200.00", remainingBudget: "3600.00", isOverBudget: false,
    categories: [{ categoryId: "1", categoryName: "Photography", plannedAmount: "3000.00", committedTotal: "1400.00",
      paidTotal: "200.00", remainingBudget: "1600.00", isOverBudget: false, extra: "ignored" }],
  },
  payments: {
    windowDays: 7, overdueTotal: "800.00", overdueCount: 1, upcomingTotal: "400.00", upcomingCount: 1,
    items: [{ expenseId: "1", description: "Deposit", vendorName: "Lens Studio", categoryName: "Photography",
      dueDate: "2026-06-07", outstandingAmount: "800.00", isOverdue: true }],
  },
  guests: { records: 3, plusOnes: 1, expectedHeadcount: 4, rsvp: { UNINVITED: 0, PENDING: 1, ACCEPTED: 1, REJECTED: 1 } },
  tasks: { total: 2, completed: 1, overdue: 0, percentComplete: 50,
    nextDue: [{ taskId: "2", title: "Send invites", dueDate: "2026-06-12", assigneeName: null }] },
  unavailable: [],
});

function respond(status, json) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, auth: init.headers.Authorization });
    return { status, ok: status >= 200 && status < 300, json: async () => json };
  };
}

test("getDashboard calls the event's dashboard route with the access token", async () => {
  requests.length = 0; currentUser = "user-1"; respond(200, body());
  const dashboard = await api.getDashboard("11");
  assert.deepEqual(requests, [{ url: "/api/events/11/dashboard", auth: "Bearer access-token" }]);
  assert.equal(dashboard.payments.items[0].vendorName, "Lens Studio");
  assert.equal(dashboard.guests.expectedHeadcount, 4);
  // Undocumented fields are dropped.
  assert.equal("extra" in dashboard.budget.categories[0], false);
});

test("a dashboard without guest data is accepted", async () => {
  respond(200, { ...body(), guests: null, unavailable: ["guests"] });
  const dashboard = await api.getDashboard("11");
  assert.equal(dashboard.guests, null);
  assert.deepEqual(dashboard.unavailable, ["guests"]);
});

test("HTTP errors become friendly messages", async () => {
  respond(401, {});
  await assert.rejects(api.getDashboard("11"), EventSessionError);
  for (const [status, message] of [[403, /no longer have access/], [404, /no longer exists/], [500, /Unable to load the dashboard/]]) {
    respond(status, { error: "internal" });
    await assert.rejects(api.getDashboard("11"), (error) => error.status === status && message.test(error.message));
  }
});

test("an invalid event ID is rejected before any request", async () => {
  requests.length = 0;
  await assert.rejects(api.getDashboard("abc"), (error) => error.status === 400);
  assert.equal(requests.length, 0);
});

test("a network failure is a retryable load error", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(api.getDashboard("11"), (error) => error.status === 0 && /Unable to load/.test(error.message));
});

test("a malformed or mismatched response is rejected", async () => {
  const broken = [
    { ...body(), eventId: "12" },
    { ...body(), budget: { ...body().budget, paidTotal: 200 } },
    { ...body(), payments: { ...body().payments, overdueCount: -1 } },
    { ...body(), tasks: { ...body().tasks, nextDue: "none" } },
    { ...body(), guests: { ...body().guests, rsvp: { PENDING: 1 } } },
    null,
  ];
  for (const json of broken) {
    respond(200, json);
    await assert.rejects(api.getDashboard("11"), (error) => error.status === 502);
  }
});

test("a different signed-in account after loading is rejected", async () => {
  currentUser = "user-2"; respond(200, body());
  await assert.rejects(api.getDashboard("11"), (error) => error.status === 409);
  currentUser = "user-1";
});

test("formatMoney matches the Budget page digits", () => {
  assert.equal(api.formatMoney("1234.50"), "$1,234.50");
  assert.equal(api.formatMoney("0.00"), "$0.00");
  assert.equal(api.formatMoney("-25.00"), "-$25.00");
});
