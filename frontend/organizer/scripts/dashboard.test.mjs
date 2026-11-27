import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function loadModule(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)((name) => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

const event = {
  event_id: "11", template_id: null, name: "Garden Wedding", event_date: "2027-06-12", venue: "Rose Hall",
  total_budget: "5000.00", role: "OWNER",
};
const dashboard = {
  eventId: "11", asOfDate: "2026-06-10",
  budget: {
    eventBudget: "5000.00", allocatedBudget: "4000.00", committedTotal: "3400.00", paidTotal: "1200.00",
    outstandingTotal: "2200.00", remainingBudget: "1600.00", isOverBudget: false,
    categories: [
      { categoryId: "1", categoryName: "Photography", plannedAmount: "3000.00", committedTotal: "1400.00", paidTotal: "200.00", remainingBudget: "1600.00", isOverBudget: false },
      { categoryId: "2", categoryName: "Catering", plannedAmount: "1000.00", committedTotal: "2000.00", paidTotal: "1000.00", remainingBudget: "-1000.00", isOverBudget: true },
    ],
  },
  payments: {
    windowDays: 7, overdueTotal: "800.00", overdueCount: 1, upcomingTotal: "400.00", upcomingCount: 1,
    items: [
      { expenseId: "1", description: "Photographer deposit", vendorName: "Lens Studio", categoryName: "Photography", dueDate: "2026-06-07", outstandingAmount: "800.00", isOverdue: true },
      { expenseId: "2", description: "Album", vendorName: null, categoryName: "Photography", dueDate: "2026-06-15", outstandingAmount: "400.00", isOverdue: false },
    ],
  },
  // 3 guests, one accepted with a plus-one: RSVP counts are people and add up to 4.
  guests: { records: 3, plusOnes: 1, expectedHeadcount: 4, rsvp: { UNINVITED: 0, PENDING: 1, ACCEPTED: 2, REJECTED: 1 } },
  tasks: {
    total: 3, completed: 1, overdue: 1, percentComplete: 33,
    nextDue: [
      { taskId: "21", title: "Send invites", dueDate: "2026-06-05", assigneeName: "Heather" },
      { taskId: "22", title: "Pick music", dueDate: "2026-06-14", assigneeName: null },
    ],
  },
  unavailable: [],
};

let state;
const Dashboard = loadModule("../src/features/dashboard/Dashboard.tsx", {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "../../components/ui": {
    Icon: () => React.createElement("i"),
    Card: ({ children }) => React.createElement("section", null, children),
    Badge: ({ children }) => React.createElement("mark", null, children),
    Button: ({ children }) => React.createElement("button", null, children),
  },
  "../../components/page": {
    StatCard: ({ label, value, detail }) => React.createElement("div", { className: "stat" }, `${label}|${value}|${detail}`),
    ErrorState: ({ message }) => React.createElement("div", { role: "alert" }, message),
  },
  "../../hooks/useResource": { useResource: () => state },
  "../../utils/dateFormat": { formatCalendarDate: (value) => `[${value}]` },
  "../events/EventsContext": { useEvents: () => ({ eventDetails: event, openCreate: () => {}, openEdit: () => {} }) },
  "../events/eventPresentation": { eventDate: (value) => value, eventInitials: () => "GW", eventRole: () => "Owner" },
  "./dashboardApi": {
    getDashboard: async () => dashboard,
    formatMoney: (amount) => `${Number(amount) < 0 ? "-" : ""}$${Math.abs(Number(amount)).toLocaleString("en-CA", { minimumFractionDigits: 2 })}`,
  },
}).Dashboard;

const render = (next) => {
  state = { data: null, loading: false, error: null, reload: () => {}, ...next };
  return renderToStaticMarkup(React.createElement(Dashboard, { go: () => {} }));
};

test("stat cards show real budget, guest, task and payment numbers", () => {
  const html = render({ data: dashboard });
  assert.match(html, /Total budget\|\$5,000.00\|\$3,400.00 committed · \$1,200.00 paid/);
  assert.match(html, /Guest responses\|2 \/ 4\|People coming · 3 guests \+ 1 plus-one/);
  assert.match(html, /Tasks complete\|33%\|1 of 3 tasks · 1 overdue/);
  // Overdue 800.00 + upcoming 400.00
  assert.match(html, /Upcoming payments\|\$1,200.00\|1 payment in 7 days · 1 overdue/);
});

test("budget snapshot lists categories and flags overspending", () => {
  const html = render({ data: dashboard });
  assert.match(html, /\$1,600.00 left of \$5,000.00/);
  assert.match(html, /Photography.*\$1,400.00 committed of \$3,000.00 planned · \$200.00 paid/);
  assert.match(html, /width:47%/); // 1400 / 3000
  // 2,000.00 committed - 1,000.00 planned. The badge sits in its own wrapper, never as a
  // direct <span> of the row (that selector is the round avatar style).
  assert.match(html, /Catering.*<div class="dashboard-flag"><mark>Over by \$1,000.00<\/mark><\/div>/);
  assert.doesNotMatch(html, /Over budget/);
  assert.match(html, /progress coral"><i style="width:100%"/); // capped at 100%
});

test("tasks and payments lists show due dates, people and overdue marks", () => {
  const html = render({ data: dashboard });
  // Overdue tasks are listed too, so the card is "Tasks due" (like "Payments due").
  assert.match(html, /<h3>Tasks due<\/h3><p>Overdue and upcoming, nearest due date first<\/p>/);
  // asOfDate is 2026-06-10: a task due before it is overdue, a later one is not.
  assert.match(html, /Send invites.*Due \[2026-06-05\] · Heather<\/small><\/div><div class="dashboard-flag"><mark>Overdue<\/mark><\/div>/);
  assert.match(html, /Pick music.*Due \[2026-06-14\] · Unassigned<\/small><\/div><\/div>/);
  assert.match(html, /Photographer deposit.*Lens Studio · Photography · due \[2026-06-07\].*<div class="dashboard-flag"><mark>Overdue<\/mark><\/div>.*\$800.00/);
  assert.match(html, /Album.*Photography · due \[2026-06-15\]/);
  assert.doesNotMatch(html, /Album<\/b><small>null/);
});

test("list footers say how many items are shown, with no extra link", () => {
  const html = render({ data: dashboard });
  // 3 tasks - 1 done = 2 open, both listed; 1 overdue + 1 upcoming payment, both listed.
  assert.match(html, /<div class="dashboard-card-foot"><span>Showing 2 of 2 open tasks<\/span><\/div>/);
  assert.match(html, /<div class="dashboard-card-foot"><span>Showing 2 of 2 payments due<\/span><\/div>/);
});

test("each card has a single link to its page, in the header", () => {
  const html = render({ data: dashboard });
  for (const link of ["View budget", "All tasks", "View expenses"]) {
    assert.equal(html.split(`>${link} <`).length - 1, 1, link);
  }
  assert.doesNotMatch(html, /View all tasks|View all expenses|View full budget/);
});

test("the budget footer summarizes overspending", () => {
  // Fixture: Photography is within budget, Catering is over.
  assert.match(render({ data: dashboard }),
    /<div class="dashboard-card-foot"><span>1 category over budget<\/span><\/div>/);
  const categories = dashboard.budget.categories;
  const allOver = categories.map((category) => ({ ...category, isOverBudget: true }));
  assert.match(render({ data: { ...dashboard, budget: { ...dashboard.budget, categories: allOver } } }), /2 categories over budget/);
  const noneOver = categories.map((category) => ({ ...category, isOverBudget: false }));
  assert.match(render({ data: { ...dashboard, budget: { ...dashboard.budget, categories: noneOver } } }), /All categories within budget/);
  const none = render({ data: { ...dashboard, budget: { ...dashboard.budget, categories: [] } } });
  assert.doesNotMatch(none, /over budget|within budget/);
});

test("the task footer counts open tasks that are not listed, with the right word for one", () => {
  const many = render({ data: { ...dashboard, tasks: { ...dashboard.tasks, total: 10, completed: 1 } } });
  assert.match(many, /Showing 2 of 9 open tasks/);
  const one = render({ data: { ...dashboard, tasks: { ...dashboard.tasks, total: 2, completed: 1, nextDue: [dashboard.tasks.nextDue[0]] } } });
  assert.match(one, /Showing 1 of 1 open task</);
});

test("with nothing to summarize, the footer is hidden", () => {
  const empty = {
    ...dashboard,
    budget: { ...dashboard.budget, categories: [] },
    payments: { ...dashboard.payments, overdueCount: 0, upcomingCount: 0, items: [] },
    tasks: { total: 0, completed: 0, overdue: 0, percentComplete: 0, nextDue: [] },
  };
  const html = render({ data: empty });
  assert.doesNotMatch(html, /dashboard-card-foot/);
});

test("a task due today is not marked overdue", () => {
  const today = { ...dashboard, tasks: { ...dashboard.tasks, nextDue: [
    { taskId: "30", title: "Call DJ", dueDate: "2026-06-10", assigneeName: null },
  ] } };
  const html = render({ data: today });
  // The row ends right after its text: no badge (the payments list below has its own).
  assert.match(html, /Call DJ<\/b><small>Due \[2026-06-10\] · Unassigned<\/small><\/div><\/div>/);
});

test("when guests can't be loaded, only the guest card says so", () => {
  const html = render({ data: { ...dashboard, guests: null, unavailable: ["guests"] } });
  assert.match(html, /Guest responses\|--\|Guest information unavailable/);
  assert.match(html, /Tasks complete\|33%/);
});

test("empty lists explain why they are empty", () => {
  const empty = {
    ...dashboard,
    budget: { ...dashboard.budget, categories: [] },
    payments: { ...dashboard.payments, overdueCount: 0, upcomingCount: 0, overdueTotal: "0.00", upcomingTotal: "0.00", items: [] },
    tasks: { total: 0, completed: 0, overdue: 0, percentComplete: 0, nextDue: [] },
  };
  const html = render({ data: empty });
  assert.match(html, /<p class="dashboard-empty">No budget categories yet\.<\/p>/);
  assert.match(html, /<p class="dashboard-empty">No tasks yet\.<\/p>/);
  assert.match(html, /<p class="dashboard-empty">No payments due in the next 7 days\.<\/p>/);
  assert.match(html, /Tasks complete\|0%\|0 of 0 tasks/);
});

test("while loading, no statistics are invented", () => {
  const html = render({ loading: true });
  assert.match(html, /Loading\.\.\./);
  assert.match(html, /Guest responses\|--/);
  assert.doesNotMatch(html, /%\|/);
});

test("a load error shows the message with a retry, and keeps the event banner", () => {
  const html = render({ error: new Error("You no longer have access to this event.") });
  assert.match(html, /role="alert">You no longer have access to this event./);
  assert.match(html, /Garden Wedding/);
  assert.doesNotMatch(html, /Budget snapshot/);
});
