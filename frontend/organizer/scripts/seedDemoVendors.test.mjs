import assert from "node:assert/strict";
import test from "node:test";
import { createApi, DEMO_OTHER_EXPENSES, DEMO_VENDORS, seedDemo } from "./seed-demo-vendors.mjs";

const WEDDING_CATEGORIES = ["Venue & Catering", "Photo & Video", "Attire & Beauty", "Flowers & Decor",
  "Music & Entertainment", "Stationery", "Other"];

/** An in-memory stand-in for the EventWise API, answering through fetch. */
function fakeApi({ categories = WEDDING_CATEGORIES } = {}) {
  const state = { events: [], vendors: [], expenses: [], payments: [], requests: [] };
  let nextId = 1;
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

  async function fetchImpl(url, init) {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/prod/, "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, path, body, auth: init.headers.Authorization });
    if (init.headers.Authorization !== "Bearer test-token") return json(401, { message: "Unauthorized" });

    if (method === "GET" && path === "/event-templates") {
      return json(200, { templates: [{ templateId: "1", templateKey: "wedding", name: "Wedding" }] });
    }
    if (path === "/events" && method === "GET") return json(200, state.events.map((e) => ({ ...e, role: "OWNER" })));
    if (path === "/events" && method === "POST") {
      const event = { event_id: String(nextId++), ...body, categories: body.template_id
        ? categories.map((name) => ({ categoryId: String(nextId++), name })) : [] };
      state.events.push(event);
      return json(201, event);
    }
    const match = path.match(/^\/events\/(\d+)\/(vendors|expenses|budget-categories)(?:\/(\d+)\/payments)?$/);
    const event = match && state.events.find((e) => e.event_id === match[1]);
    if (!event) return json(403, { error: { code: "FORBIDDEN", message: "No access" } });
    const [, eventId, kind, expenseId] = match;

    if (kind === "budget-categories") return json(200, { eventId, totalBudget: "0.00", categories: event.categories });
    if (kind === "vendors" && method === "GET") return json(200, state.vendors.filter((v) => v.eventId === eventId));
    if (kind === "vendors" && method === "POST") {
      const vendor = { id: nextId++, eventId, bookingStatus: body.quoteAmount ? "QUOTED" : "RESEARCHING",
        contractStatus: "NOT_STARTED", ...body };
      if (vendor.contractStatus === "SIGNED") vendor.bookingStatus = "BOOKED";
      state.vendors.push(vendor);
      return json(201, vendor);
    }
    if (kind === "expenses" && expenseId) {
      assert.ok(state.expenses.some((e) => e.expenseId === expenseId), "payment for an unknown expense");
      state.payments.push({ expenseId, ...body });
      return json(201, { data: { payment: body } });
    }
    if (kind === "expenses" && method === "GET") {
      const all = state.expenses.filter((e) => e.eventId === eventId);
      const offset = Number(searchParams.get("offset")), limit = Number(searchParams.get("limit"));
      return json(200, { data: all.slice(offset, offset + limit), total: all.length, limit, offset });
    }
    if (kind === "expenses" && method === "POST") {
      assert.ok(event.categories.some((c) => c.categoryId === body.categoryId), "expense with a category from another event");
      const expense = { expenseId: String(nextId++), eventId, ...body };
      state.expenses.push(expense);
      return json(201, { data: expense });
    }
    return json(404, { error: { message: "No route" } });
  }
  return { state, api: createApi("https://api.example/prod", "test-token", fetchImpl) };
}

const quiet = { log: () => {} };
const demoExpenseCount = DEMO_VENDORS.reduce((n, v) => n + v.expenses.length, 0) + DEMO_OTHER_EXPENSES.length;
const demoPaymentCount = [...DEMO_VENDORS.flatMap((v) => v.expenses), ...DEMO_OTHER_EXPENSES]
  .reduce((n, e) => n + e.payments.length, 0);

const cents = (value) => Math.round(Number(value) * 100);

test("demo data shows no vendor warnings: expenses match contracts, nothing overpaid", () => {
  for (const { vendor, expenses } of DEMO_VENDORS) {
    // Same rule as contractExpenseSummary().mismatch on the Vendors page.
    if (vendor.contractTotal && expenses.length) {
      const total = expenses.reduce((sum, e) => sum + cents(e.committedAmount), 0);
      assert.equal(total, cents(vendor.contractTotal), `${vendor.name}: linked expenses must add up to the contract total`);
    }
    const paid = expenses.flatMap((e) => e.payments).reduce((sum, p) => sum + cents(p.amount), 0);
    assert.ok(!vendor.contractTotal || paid <= cents(vendor.contractTotal), `${vendor.name} is overpaid`);
  }
  for (const e of [...DEMO_VENDORS.flatMap((v) => v.expenses), ...DEMO_OTHER_EXPENSES]) {
    const paid = e.payments.reduce((sum, p) => sum + cents(p.amount), 0);
    assert.ok(paid <= cents(e.committedAmount), `${e.description} is overpaid`);
  }
});

test("first run creates the wedding, every vendor, expense and payment", async () => {
  const { state, api } = fakeApi();
  const summary = await seedDemo(api, quiet);

  assert.equal(summary.eventCreated, true);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].template_id, "1");
  assert.equal(summary.vendorsCreated, DEMO_VENDORS.length);
  assert.equal(summary.expensesCreated, demoExpenseCount);
  assert.equal(summary.paymentsRecorded, demoPaymentCount);
  assert.deepEqual(summary.warnings, []);

  // Each expense uses the budget category named like its vendor's category.
  const categoryName = new Map(state.events[0].categories.map((c) => [c.categoryId, c.name]));
  const willow = state.vendors.find((v) => v.name === "The Willow House");
  const venueExpenses = state.expenses.filter((e) => e.vendorId === String(willow.id));
  assert.deepEqual(venueExpenses.map((e) => e.description), ["Venue deposit", "Venue balance"]);
  assert.ok(venueExpenses.every((e) => categoryName.get(e.categoryId) === "Venue & Catering"));
  assert.equal(state.expenses.find((e) => e.description === "Marriage licence").vendorId, null);
  assert.ok(state.requests.every((r) => r.auth === "Bearer test-token"));
});

test("a second run reuses the event and adds nothing", async () => {
  const { state, api } = fakeApi();
  await seedDemo(api, quiet);
  const before = { vendors: state.vendors.length, expenses: state.expenses.length, payments: state.payments.length };

  const summary = await seedDemo(api, quiet);
  assert.equal(summary.eventCreated, false);
  assert.equal(summary.eventId, state.events[0].event_id);
  assert.equal(state.events.length, 1);
  assert.equal(summary.vendorsSkipped, DEMO_VENDORS.length);
  assert.equal(summary.paymentsRecorded, 0);
  assert.deepEqual(
    { vendors: state.vendors.length, expenses: state.expenses.length, payments: state.payments.length }, before);
});

test("a run after a partial failure fills in only what is missing", async () => {
  const { state, api } = fakeApi();
  await seedDemo(api, quiet);
  // Pretend the first run stopped before the last two vendors and the vendorless expense.
  state.vendors.splice(-2);
  state.expenses = state.expenses.filter((e) => e.description !== "Marriage licence");

  const summary = await seedDemo(api, quiet);
  assert.equal(summary.vendorsCreated, 2);
  assert.equal(summary.expensesCreated, 1);
  assert.equal(state.vendors.length, DEMO_VENDORS.length);
});

test("--new-event creates a second event even when the name exists", async () => {
  const { state, api } = fakeApi();
  await seedDemo(api, quiet);
  await seedDemo(api, { ...quiet, newEvent: true });
  assert.equal(state.events.length, 2);
  assert.equal(state.vendors.length, DEMO_VENDORS.length * 2);
});

test("an event with no budget categories gets vendors and warnings instead of expenses", async () => {
  const { state, api } = fakeApi({ categories: [] });
  const summary = await seedDemo(api, quiet);
  assert.equal(state.vendors.length, DEMO_VENDORS.length);
  assert.equal(state.expenses.length, 0);
  assert.equal(summary.warnings.length, demoExpenseCount);
});

test("errors name the request and the API's field messages", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: { code: "VALIDATION_FAILED", message: "Some fields need fixing.", fields: { email: "Enter a valid email address" } },
  }), { status: 422 });
  const api = createApi("https://api.example", "t", fetchImpl);
  await assert.rejects(api("POST", "/events/1/vendors", {}),
    /POST \/events\/1\/vendors failed with 422: Some fields need fixing\. \{"email":"Enter a valid email address"\}/);
});

test("an expired token gives a sign-in-again message", async () => {
  const api = createApi("https://api.example", "expired", async () => new Response("{}", { status: 401 }));
  await assert.rejects(api("GET", "/events"), /401: not signed in or the token expired/);
});
