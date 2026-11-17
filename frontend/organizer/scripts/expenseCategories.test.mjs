import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function load(path, imports = {}) {
  const source = readFileSync(new URL("../src/" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "document", compiled)(name => {
    if (name.endsWith(".css")) return {};
    assert.ok(name in imports, "Unexpected import: " + name);
    return imports[name];
  }, module, module.exports, { activeElement: null });
  return module.exports;
}

function host() {
  const states = [], effects = [], refs = [], pending = [];
  let si = 0, ei = 0, ri = 0;
  const react = {
    useState(initial) {
      const i = si++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }];
    },
    useRef(initial) { return refs[ri++] ??= { current: initial }; },
    useEffect(callback, deps) {
      const i = ei++;
      if (!effects[i] || deps.some((value, j) => value !== effects[i].deps[j])) pending.push(() => {
        effects[i]?.cleanup?.();
        effects[i] = { deps, cleanup: callback() };
      });
    },
  };
  return { react, render(callback) {
    si = ei = ri = 0;
    const result = callback();
    while (pending.length) pending.shift()();
    return result;
  }, cleanup() { for (const effect of effects) effect?.cleanup?.(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const category = (eventId = "10", categoryId = "123", name = "Cake") => ({ eventId, categoryId, name });
const response = (eventId = "10", categories = [category(eventId)]) => ({ eventId, categories });
function hookHost() {
  const h = host(), requests = [];
  const { useEventCategories } = load("features/categories/useEventCategories.ts", {
    react: h.react, "../budgets/budgetApi": { fetchBudgetCategories: eventId => new Promise((resolve, reject) => requests.push({ eventId, resolve, reject })) },
  });
  return { ...h, requests, categories(eventId = "10", account = "owner") { return h.render(() => useEventCategories(eventId, account)); } };
}

test("category hook loads event categories and returns an empty state without an event/account", async () => {
  const h = hookHost();
  assert.equal(h.categories(null).loading, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.categories("10", "").loading, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.categories().loading, true);
  h.requests[0].resolve(response());
  await tick();
  assert.deepEqual(h.categories().categories, [category()]);
  assert.equal(h.categories().loading, false);
  h.cleanup();
});

test("event and account switching hide old options immediately and ignore late replies", async () => {
  const h = hookHost();
  h.categories("10", "a");
  assert.deepEqual(h.categories("20", "a").categories, []);
  h.requests[1].resolve(response("20"));
  await tick();
  assert.equal(h.categories("20", "a").categories[0].eventId, "20");
  h.requests[0].resolve(response("10"));
  await tick();
  assert.equal(h.categories("20", "a").categories[0].eventId, "20");
  assert.deepEqual(h.categories("20", "b").categories, []);
  assert.equal(h.categories("20", "b").loading, true);
  h.requests[2].resolve(response("20", []));
  await tick();
  assert.deepEqual(h.categories("20", "b").categories, []);
  assert.equal(h.categories("20", "b").loading, false);
  h.cleanup();
});

test("errors can be retried and stale errors cannot replace another event's result", async () => {
  const h = hookHost();
  h.categories();
  h.requests[0].reject(new Error("private details"));
  await tick();
  assert.equal(h.categories().error, "Couldn't load categories for this event.");
  h.categories().retry();
  assert.equal(h.categories().loading, true);
  h.categories("20");
  h.requests[2].resolve(response("20"));
  h.requests[1].reject(new Error("stale failure"));
  await tick();
  assert.equal(h.categories("20").error, "");
  assert.equal(h.categories("20").categories[0].eventId, "20");
  h.cleanup();
});

for (const result of [
  response("20"),
  response("10", [category("20")]),
  response("10", [category(), category()]),
]) {
  test("category hook rejects mismatched event data or duplicate IDs", async () => {
    const h = hookHost();
    h.categories();
    h.requests[0].resolve(result);
    await tick();
    assert.deepEqual(h.categories().categories, []);
    assert.ok(h.categories().error);
    h.cleanup();
  });
}

const { CategorySelect } = load("features/categories/CategorySelect.tsx", {
  react: React, "react/jsx-runtime": jsx,
  "react-router-dom": { Link: ({ to, ...props }) => React.createElement("a", { ...props, href: to }) },
});
const selector = overrides => renderToStaticMarkup(React.createElement(CategorySelect, {
  categories: [category()], value: "123", onChange() {}, loading: false, loadError: "", onRetry() {}, ...overrides,
}));
test("selector displays names with ID values and preserves edit selections", () => {
  const html = selector({});
  assert.match(html, /value="123" selected="">Cake/);
  assert.match(html, /name="categoryId"/);
  assert.match(html, /required/);
});
test("selector distinguishes loading, errors, empty categories and deleted selections", () => {
  assert.match(selector({ loading: true }), /Loading categories/);
  assert.match(selector({ loadError: "Unavailable" }), /Retry categories/);
  assert.match(selector({ categories: [] }), /href="\/app\/budget"/);
  const html = selector({ value: "999" });
  assert.match(html, /Previous category unavailable/);
  assert.match(html, /Choose a category from this event/);
});

const draftModule = load("features/expenses/expenseDraft.ts", { "../../data/mockData": { CURRENT_EVENT_ID: "demo" } });
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit; } return null; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function formHost(expense) {
  const h = host(), saves = [];
  let categoryState = { categories: [category()], loading: false, error: "", retry() {} };
  const Category = () => null;
  const { ExpenseForm } = load("features/expenses/ExpenseForm.tsx", {
    react: h.react, "react/jsx-runtime": jsx,
    "../../components/ui": { Button: () => null, Icon: () => null },
    "./expenseDraft": draftModule,
    "../categories/CategorySelect": { CategorySelect: Category },
    "../categories/useEventCategories": { useEventCategories: (eventId, accountId) => {
      assert.equal(eventId, "10"); assert.equal(accountId, "owner"); return categoryState;
    } },
  });
  const props = { eventId: "10", accountId: "owner", vendors: [], expense, onSave: value => saves.push(value), onClose() {} };
  const render = () => h.render(() => ExpenseForm(props));
  return { saves, render, category: () => find(render(), n => n.type === Category),
    change(name, value) { find(render(), n => n.props?.name === name).props.onChange({ target: { value } }); },
    select(value) { this.category().props.onChange(value); },
    submit() { find(render(), n => n.type === "form").props.onSubmit({ preventDefault() {} }); },
    state(value) { categoryState = value; },
  };
}
test("expense form requires a category, saves its ID/label and selected event, and rejects another event's category", () => {
  const h = formHost();
  h.change("name", "Birthday cake"); h.change("amount", "200.00");
  h.submit();
  assert.equal(h.saves.length, 0);
  assert.equal(h.category().props.error, "Choose a category from this event.");
  h.select("foreign"); h.submit();
  assert.equal(h.saves.length, 0);
  h.select("123"); h.submit();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].categoryId, "123");
  assert.equal(h.saves[0].category, "Cake");
  assert.equal(h.saves[0].eventId, "10");
});
test("editing retains the selected category and payment data; deleted category must be replaced", () => {
  const saved = { id: "5", eventId: "10", vendorId: null, vendor: "Cake", categoryId: "123", category: "Old name", total: 200, paid: 50, due: "No due date", dueDate: null, status: "Partially paid", payments: [{ id: "1", amount: 50 }] };
  const h = formHost(saved);
  assert.equal(h.category().props.value, "123");
  h.submit();
  assert.equal(h.saves[0].category, "Cake");
  assert.deepEqual(h.saves[0].payments, saved.payments);
  const stale = formHost({ ...saved, categoryId: "removed" });
  stale.submit();
  assert.equal(stale.saves.length, 0);
});
test("loading/error/empty categories block saving and a cross-event expense cannot be edited", () => {
  for (const state of [
    { categories: [], loading: true, error: "" },
    { categories: [], loading: false, error: "Unavailable" },
    { categories: [], loading: false, error: "" },
  ]) {
    const h = formHost();
    h.change("name", "Cake"); h.change("amount", "20");
    h.state({ ...state, retry() {} });
    h.select("123"); h.submit();
    assert.equal(h.saves.length, 0);
  }
  const h = formHost({ id: "5", eventId: "other", vendorId: null, vendor: "Cake", categoryId: "123", total: 20, paid: 0 });
  h.submit();
  assert.equal(h.saves.length, 0);
});
test("existing contract amount updates preserve category ID/label without needing dropdown data", () => {
  const original = { id: "5", eventId: "10", vendorId: null, categoryId: "123", category: "Cake", total: 200, paid: 50, due: "No due date" };
  const updated = draftModule.expenseFromDraft({ name: "Cake", amount: "250", dueDate: "" }, original, false);
  assert.equal(updated.categoryId, "123");
  assert.equal(updated.category, "Cake");
});

test("category hook ignores a response after unmount", async () => {
  const h = hookHost();
  h.categories();
  h.cleanup();
  h.requests[0].resolve(response());
  await tick();
  assert.deepEqual(h.categories().categories, []);
});
test("expense page resets its form state by selected account/event rather than the sample event", () => {
  let selection = { selectedId: "10", userId: "owner" };
  const { Expenses } = load("features/expenses/Expenses.tsx", {
    "react/jsx-runtime": jsx, react: {}, "react-router-dom": {},
    "../../utils/dateFormat": {}, "../../hooks/useResource": {}, "../../services/vendorService": {},
    "../../services/mockExpenseStore": {}, "../../components/ui": {}, "../../components/page": {},
    "../../data/mockData": { CURRENT_EVENT_ID: "demo" },
    "../events/EventsContext": { useEvents: () => selection },
    "../categories/useEventCategories": {},
    "./ExpenseActions": {}, "./ExpenseForm": {}, "./ExpenseDeleteDialog": {}, "./ExpensePaymentForm": {},
    "./expensePayments": {}, "./expenseDraft": {},
  });
  const first = Expenses();
  assert.equal(first.props.eventId, "10");
  selection = { selectedId: "20", userId: "owner" };
  const second = Expenses();
  assert.equal(second.props.eventId, "20");
  assert.notEqual(first.key, second.key);
  selection = { selectedId: "20", userId: "other" };
  assert.notEqual(Expenses().key, second.key);
});

function findAll(node, predicate) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate));
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
function tableHost(vendorId = "") {
  const h = host();
  h.react.useCallback = callback => callback;
  let params = new URLSearchParams(vendorId ? "vendorId=" + vendorId + "&keep=yes" : "");
  let retries = 0;
  let categoryState = { categories: [category("10", "123", "Photography"), category("10", "124", "Photography")], loading: false, error: "", retry: () => retries++ };
  const expenses = [
    { id: "1", eventId: "10", vendorId: "v1", vendor: "Venue fee", categoryId: "123", category: "Photography", total: 100, paid: 0, status: "Unpaid" },
    { id: "2", eventId: "10", vendorId: "v1", vendor: "Photo deposit", categoryId: "124", category: "Photography", total: 200, paid: 50, status: "Deposit paid" },
    { id: "3", eventId: "10", vendorId: "v2", vendor: "Photo balance", categoryId: "123", category: "Photography", total: 300, paid: 300, status: "Paid" },
    { id: "4", eventId: "10", vendorId: null, vendor: "Legacy expense", category: "Photography", total: 400, paid: 0, status: "Unpaid" },
  ];
  const component = load("features/expenses/Expenses.tsx", {
    react: h.react, "react/jsx-runtime": jsx,
    "react-router-dom": { useSearchParams: () => [params, change => { params = typeof change === "function" ? change(params) : change; }] },
    "../../utils/dateFormat": { formatCalendarDate: () => "No due date" },
    "../../hooks/useResource": { useResource: () => ({ data: [{ id: "v1", eventId: "10", name: "Vendor One" }, { id: "v2", eventId: "10", name: "Vendor Two" }], loading: false, error: null }) },
    "../../services/vendorService": { vendorService: { list: async () => [] } },
    "../../services/mockExpenseStore": { mockExpenseStore: { list: () => expenses } },
    "../../components/ui": { Badge: () => null, Button: () => null, Card: () => null, Icon: () => null },
    "../../components/page": { EmptyState: () => null, ErrorState: () => null, PageHeader: () => null, StatCard: () => null },
    "../../data/mockData": { CURRENT_EVENT_ID: "10" },
    "../events/EventsContext": { useEvents: () => ({ selectedId: "10", userId: "owner" }) },
    "../categories/useEventCategories": { useEventCategories: (eventId, accountId) => {
      assert.equal(eventId, "10"); assert.equal(accountId, "owner"); return categoryState;
    } },
    "./ExpenseActions": { ExpenseActions: () => null }, "./ExpenseForm": { ExpenseForm: () => null },
    "./ExpenseDeleteDialog": { ExpenseDeleteDialog: () => null }, "./ExpensePaymentForm": { ExpensePaymentForm: () => null },
    "./expensePayments": {}, "./expenseDraft": draftModule,
  });
  const page = component.Expenses();
  const render = () => h.render(() => page.type(page.props));
  return {
    render,
    filter: () => find(render(), node => node.props?.["aria-label"] === "Filter expenses by category"),
    select(id) { this.filter().props.onChange({ target: { value: id } }); },
    rows: () => findAll(render(), node => node.type === "tr" && node.props.className === "expense-row").map(node => node.key),
    search(value) { find(render(), node => node.props?.["aria-label"] === "Search expenses").props.onChange({ target: { value } }); },
    status(value) { find(render(), node => node.type === "button" && node.props.children === value).props.onClick(); },
    clear() { find(render(), node => node.type === "button" && node.props.children === "Clear filters").props.onClick(); },
    summary: () => find(render(), node => node.props?.label === "Total expenses").props.value,
    categoryState: value => { categoryState = { ...categoryState, ...value }; },
    retries: () => retries,
    params: () => params,
  };
}
test("table category filter uses IDs, not equal display names, and preserves summary totals", () => {
  const h = tableHost();
  assert.deepEqual(h.rows(), ["1", "2", "3", "4"]);
  const total = h.summary();
  h.select("123");
  assert.deepEqual(h.rows(), ["1", "3"]);
  assert.equal(h.summary(), total);
  h.select("124");
  assert.deepEqual(h.rows(), ["2"]);
  h.select("");
  assert.deepEqual(h.rows(), ["1", "2", "3", "4"]);
});
test("category, case-insensitive search, payment status and vendor filters work together and clear together", () => {
  const h = tableHost("v1");
  h.select("123");
  h.status("Unpaid");
  h.search("VENDOR ONE");
  assert.deepEqual(h.rows(), ["1"]);
  h.search("does not exist");
  assert.deepEqual(h.rows(), []);
  assert.ok(find(h.render(), node => node.props?.title === "No matching expenses"));
  h.clear();
  assert.equal(h.filter().props.value, "");
  assert.deepEqual(h.rows(), ["1", "2", "3", "4"]);
  assert.equal(h.params().get("vendorId"), null);
  assert.equal(h.params().get("keep"), "yes");
});
test("table category loading/errors have feedback and retry without hiding existing expenses", () => {
  const h = tableHost();
  h.categoryState({ loading: true, categories: [] });
  assert.equal(h.filter().props.disabled, true);
  assert.deepEqual(h.rows(), ["1", "2", "3", "4"]);
  h.categoryState({ loading: false, error: "Couldn't load categories." });
  assert.equal(h.filter().props.disabled, true);
  find(h.render(), node => node.type === "button" && node.props.children === "Retry categories").props.onClick();
  assert.equal(h.retries(), 1);
  h.categoryState({ error: "", categories: [] });
  assert.ok(find(h.render(), node => node.props?.children === "No budget categories are available for this event."));
});
test("an unavailable selected category is explicit and Clear filters still restores all rows", () => {
  const h = tableHost();
  h.select("123");
  h.categoryState({ categories: [category("10", "124", "Other")] });
  assert.ok(find(h.filter(), node => node.type === "option" && node.props.children === "Category unavailable"));
  assert.deepEqual(h.rows(), ["1", "3"]);
  h.clear();
  assert.deepEqual(h.rows(), ["1", "2", "3", "4"]);
});
