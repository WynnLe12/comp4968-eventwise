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
const { ExpenseSaveError, ExpenseDeleteError } = load("services/expenseService.ts", {
  "../features/auth/services/authService": {}, "./apiConfig": {},
});
function formHost(expense, onSave) {
  const h = host(), saves = [];
  let closes = 0;
  let categoryState = { categories: [category()], loading: false, error: "", retry() {} };
  const Category = () => null;
  const { ExpenseForm } = load("features/expenses/ExpenseForm.tsx", {
    react: h.react, "react/jsx-runtime": jsx,
    "../../components/ui": { Button: () => null, Icon: () => null },
    "./expenseDraft": draftModule,
    "../../services/expenseService": { ExpenseSaveError },
    "../categories/CategorySelect": { CategorySelect: Category },
    "../categories/useEventCategories": { useEventCategories: (eventId, accountId) => {
      assert.equal(eventId, "10"); assert.equal(accountId, "owner"); return categoryState;
    } },
  });
  const props = { eventId: "10", accountId: "owner", vendors: [], expense, onSave: value => { saves.push(value); return onSave?.(value); }, onClose() { closes++; } };
  const render = () => h.render(() => ExpenseForm(props));
  return { saves, render, category: () => find(render(), n => n.type === Category),
    change(name, value) { find(render(), n => n.props?.name === name).props.onChange({ target: { value } }); },
    select(value) { this.category().props.onChange(value); },
    submit() { return find(render(), n => n.type === "form").props.onSubmit({ preventDefault() {} }); },
    close() { find(render(), n => n.type === "dialog").props.onCancel({ preventDefault() {} }); },
    closes: () => closes,
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
    "../../services/expenseService": {}, "../../components/ui": {}, "../../components/page": {},
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
  let vendorLoader, expenseLoader;
  let expenseState;
  const vendorRequests = [], createRequests = [], updateRequests = [], deleteRequests = [];
  const h = host();
  h.react.useCallback = callback => callback;
  let params = new URLSearchParams(vendorId ? "vendorId=" + vendorId + "&keep=yes" : "");
  let retries = 0;
  let categoryState = { categories: [category("10", "123", "Photography"), category("10", "124", "Photography")], loading: false, error: "", retry: () => retries++ };
  let expenses = [
    { id: "1", eventId: "10", vendorId: "v1", vendor: "Venue fee", categoryId: "123", category: "Photography", total: 100, paid: 0, status: "Unpaid" },
    { id: "2", eventId: "10", vendorId: "v1", vendor: "Photo deposit", categoryId: "124", category: "Photography", total: 200, paid: 50, status: "Deposit paid" },
    { id: "3", eventId: "10", vendorId: "v2", vendor: "Photo balance", categoryId: "123", category: "Photography", total: 300, paid: 300, status: "Paid" },
    { id: "4", eventId: "10", vendorId: null, vendor: "Legacy expense", category: "Photography", total: 400, paid: 0, status: "Unpaid" },
  ];
  const component = load("features/expenses/Expenses.tsx", {
    react: h.react, "react/jsx-runtime": jsx,
    "react-router-dom": { useSearchParams: () => [params, change => { params = typeof change === "function" ? change(params) : change; }] },
    "../../utils/dateFormat": { formatCalendarDate: () => "No due date" },
    "../../hooks/useResource": { useResource: loader => { if (String(loader).includes("expenseService")) { expenseLoader = loader; return expenseState ?? { data: expenses, loading: false, error: null, reload() {}, update(change) { expenses = change(expenses); } }; } vendorLoader = loader; return { data: [{ id: "v1", eventId: "10", name: "Vendor One" }, { id: "v2", eventId: "10", name: "Vendor Two" }], loading: false, error: null }; } },
    "../../services/vendorService": { vendorService: { list: async eventId => { vendorRequests.push(eventId); return []; } } },
    "../../services/expenseService": { expenseService: { list: async eventId => expenses.filter(expense => expense.eventId === eventId), create: async (eventId, input) => {
      createRequests.push({ eventId, input }); return { id: "900", eventId, vendorId: input.vendorId, categoryId: input.categoryId,
        vendor: input.description, category: "Photography", total: Number(input.committedAmount), paid: 0, status: "Unpaid", dueDate: input.dueDate };
    }, update: async (eventId, expenseId, input) => {
      updateRequests.push({ eventId, expenseId, input });
      const original = expenses.find(expense => expense.id === expenseId);
      return { ...original, vendor: input.description, categoryId: input.categoryId, category: "Photography",
        vendorId: input.vendorId, total: Number(input.committedAmount), dueDate: input.dueDate };
    }, remove: async (eventId, expenseId) => { deleteRequests.push({ eventId, expenseId }); } } },
    "../../components/ui": { Badge: () => null, Button: () => null, Card: () => null, Icon: () => null },
    "../../components/page": { EmptyState: () => null, ErrorState: () => null, PageHeader: () => null, StatCard: () => null },
    "../../data/mockData": { CURRENT_EVENT_ID: "demo" },
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
    loadVendorOptions() { render(); return vendorLoader(); },
    vendorRequests, createRequests, updateRequests, deleteRequests,
    openDelete(id) { find(render(), node => node.props?.expense?.id === id && node.props?.onDelete).props.onDelete(); },
    deleteDialog: () => find(render(), node => node.props?.onConfirm),
    openEdit(id) { find(render(), node => node.props?.expense?.id === id && node.props?.onEdit).props.onEdit(); },
    expense: id => find(render(), node => node.props?.expense?.id === id && node.props?.onEdit)?.props.expense,
    openAdd() { find(render(), node => node.props?.page === "expenses").props.action.props.onClick(); },
    form: () => find(render(), node => node.props?.onSave && node.props?.accountId),
    loadExpenseRows() { render(); return expenseLoader(); },
    expenseState: value => { expenseState = value; },
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

test("expense vendor loader calls the real adapter for the selected non-sample event", async () => {
  const h = tableHost();
  await h.loadVendorOptions();
  assert.deepEqual(h.vendorRequests, ["10"]);
});


test("expense table loads saved rows and hides totals on loading or API failure", async () => {
  const h = tableHost();
  assert.equal((await h.loadExpenseRows()).length, 4);
  h.expenseState({ loading: true, data: null, error: null });
  assert.ok(find(h.render(), node => node.props?.label === "Loading expenses..."));
  assert.deepEqual(h.rows(), []);
  let retries = 0;
  h.expenseState({ loading: false, data: null, error: new Error("Please sign in again."), reload() { retries++; } });
  const error = find(h.render(), node => node.props?.message === "Please sign in again.");
  assert.ok(error);
  error.props.onRetry();
  assert.equal(retries, 1);
  assert.deepEqual(h.rows(), []);
});


test("expense creation waits for saving, blocks double submits/closing, and preserves the draft on failure", async () => {
  let reject;
  const h = formHost(undefined, () => new Promise((resolve, fail) => { reject = fail; }));
  h.change("name", "Cake"); h.change("amount", "250"); h.select("123");
  const pending = h.submit();
  assert.equal(find(h.render(), node => node.type === "form").props["aria-busy"], true);
  await h.submit(); h.close();
  assert.equal(h.saves.length, 1); assert.equal(h.closes(), 0);
  reject(new ExpenseSaveError("Check the selected category.", { categoryId: "Choose a category from this event." }));
  await pending;
  assert.equal(find(h.render(), node => node.props?.name === "name").props.value, "Cake");
  assert.equal(h.category().props.error, "Choose a category from this event.");
  assert.ok(find(h.render(), node => node.props?.role === "alert" && node.props.children === "Check the selected category."));
  assert.equal(find(h.render(), node => node.type === "form").props["aria-busy"], false);
  h.close(); assert.equal(h.closes(), 1);
});

test("successful expense creation sends the selected event and category, uses the saved ID, and clears table filters", async () => {
  const h = tableHost();
  h.select("123"); h.search("not visible"); h.openAdd();
  await h.form().props.onSave({ id: "temporary", eventId: "10", categoryId: "123", vendorId: "v1", vendor: "New saved fee", total: 250.01, dueDate: null });
  assert.deepEqual(h.createRequests, [{ eventId: "10", input: { categoryId: "123", vendorId: "v1", description: "New saved fee", committedAmount: "250.01", dueDate: null } }]);
  assert.equal(h.form(), null);
  assert.equal(h.rows()[0], "900");
  assert.equal(h.filter().props.value, "");
});


test("expense editing PATCHes the existing ID, preserves paid totals, and replaces the row without duplication", async () => {
  const h = tableHost();
  h.openEdit("2");
  assert.equal(h.form().props.expense.paid, 50);
  await h.form().props.onSave({ ...h.form().props.expense, vendor: "Updated deposit", total: 250, categoryId: "123", dueDate: "2026-12-01" });
  assert.equal(h.createRequests.length, 0);
  assert.deepEqual(h.updateRequests, [{ eventId: "10", expenseId: "2", input: {
    categoryId: "123", vendorId: "v1", description: "Updated deposit", committedAmount: "250.00", dueDate: "2026-12-01"
  } }]);
  assert.equal(h.expense("2").total, 250);
  assert.equal(h.expense("2").paid, 50);
  assert.equal(h.form(), null);
  assert.deepEqual(h.rows(), ["1", "2", "3", "4"]);
});
test("editing blocks reductions below already paid and Cancel discards changes without saving", async () => {
  const saved = { id: "5", eventId: "10", vendorId: null, vendor: "Cake", categoryId: "123", total: 200, paid: 50, dueDate: null };
  const h = formHost(saved);
  h.change("amount", "49");
  await h.submit();
  assert.equal(h.saves.length, 0);
  assert.ok(find(h.render(), node => node.props?.id === "expense-amount-error"));
  h.close();
  assert.equal(h.closes(), 1);
  assert.equal(h.saves.length, 0);
});


test("expense deletion waits for confirmation, removes only the selected row, and updates summary totals", async () => {
  const h = tableHost();
  const before = h.summary();
  h.openDelete("1");
  h.deleteDialog().props.onClose();
  assert.equal(h.deleteRequests.length, 0);
  assert.equal(h.rows().length, 4);
  h.openDelete("1");
  await h.deleteDialog().props.onConfirm();
  assert.deepEqual(h.deleteRequests, [{ eventId: "10", expenseId: "1" }]);
  assert.deepEqual(h.rows(), ["2", "3", "4"]);
  assert.notEqual(h.summary(), before);
  assert.equal(h.deleteDialog(), null);
});

function deleteDialogHost(expense, onConfirm) {
  const h = host(); let closes = 0;
  const Button = () => null;
  const { ExpenseDeleteDialog } = load("features/expenses/ExpenseDeleteDialog.tsx", {
    react: h.react, "react/jsx-runtime": jsx,
    "../../components/ui": { Button, Icon: () => null },
    "../../services/expenseService": { ExpenseDeleteError },
    "./expenseDeletion": load("features/expenses/expenseDeletion.ts"),
  });
  const render = () => h.render(() => ExpenseDeleteDialog({ expense, onConfirm, onClose() { closes++; } }));
  return { render, closes: () => closes,
    confirm() { find(render(), node => node.type === Button && node.props.variant === "danger")?.props.onClick(); },
    close() { find(render(), node => node.type === "dialog").props.onCancel({ preventDefault() {} }); },
    button: () => find(render(), node => node.type === Button && node.props.variant === "danger"),
  };
}
test("delete dialog blocks payment history, even when fully paid or refunded", () => {
  for (const expense of [{ paid: 50, total: 50 }, { paid: 0, total: 50, payments: [{ id: "old", amount: 50 }] }]) {
    let calls = 0;
    const h = deleteDialogHost({ vendor: "Cake", ...expense }, () => { calls++; });
    assert.equal(h.button(), null); h.confirm();
    assert.equal(calls, 0);
    assert.ok(find(h.render(), node => node.props?.id === "expense-delete-title" && node.props.children === "Expense can\x27t be deleted"));
  }
});
test("delete dialog blocks duplicate requests and closing while pending, then preserves failed deletions for retry", async () => {
  let reject, calls = 0;
  const h = deleteDialogHost({ vendor: "Cake", paid: 0, total: 50 }, () => { calls++; return new Promise((resolve, fail) => { reject = fail; }); });
  h.confirm(); h.confirm(); h.close();
  assert.equal(calls, 1); assert.equal(h.closes(), 0); assert.equal(h.button().props.disabled, true);
  reject(new Error("Could not delete. Try again.")); await tick();
  assert.ok(find(h.render(), node => node.props?.role === "alert" && node.props.children === "Could not delete. Try again."));
  assert.equal(h.button().props.disabled, false);
  h.close(); assert.equal(h.closes(), 1);
});
test("backend payment-history conflicts turn the delete confirmation into a blocked dialog", async () => {
  const h = deleteDialogHost({ vendor: "Refunded", paid: 0, total: 50 }, async () => { throw new ExpenseDeleteError("Keep payment history.", "HAS_PAYMENTS"); });
  h.confirm(); await tick();
  assert.equal(h.button(), null);
  assert.ok(find(h.render(), node => node.props?.role === "alert" && node.props.children === "Keep payment history."));
});
