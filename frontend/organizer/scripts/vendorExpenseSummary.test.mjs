import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

function load(path, imports = {}) {
  const source = readFileSync(new URL("../src/" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    if (name.endsWith(".css")) return {};
    assert.ok(name in imports, "Unexpected import: " + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const contract = load("services/vendorExpenseContract.ts", {
  "./mockExpenseStore": { mockExpenseStore: { list() { throw new Error("Must not read mock expenses"); } } },
  "../features/expenses/expenseDraft": {},
});
const vendor = { id: "90", eventId: "10", name: "Photographer", category: null, contactName: null,
  contractTotal: "200.00", quoteAmount: "150.00", contractStatus: "SIGNED", bookingStatus: "BOOKED",
  paidTotal: "25.00", balance: "175.00", nextDueDate: "2026-12-01" };
const expense = overrides => ({ id: "1", eventId: "10", vendorId: "90", total: 100, paid: 25, ...overrides });
function findAll(node, predicate) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(child => findAll(child, predicate));
  return [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];
}
const find = (node, predicate) => findAll(node, predicate)[0];

test("vendor comparisons use only saved expenses from that event/vendor and do not activate mock mutations", () => {
  const source = [expense(), expense({ id: "2", total: 50.01, paid: 10.01 }),
    expense({ id: "3", eventId: "20" }), expense({ id: "4", vendorId: "91" }), expense({ id: "5", vendorId: null })];
  const summary = contract.contractExpenseSummary(vendor, source);
  assert.equal(summary.total, "150.01");
  assert.equal(summary.paidCents, 3501);
  assert.equal(summary.expenses.length, 2);
  assert.equal(summary.mismatch, true);
  assert.equal(vendor.paidTotal, "25.00"); // The vendor API remains authoritative.
  assert.equal(contract.CONTRACT_EXPENSES_ENABLED, false);
  assert.equal(contract.canAddContractExpense(vendor), false);
});
test("matching totals, no linked expenses, and vendors without contracts do not show false mismatches", () => {
  assert.equal(contract.contractExpenseSummary(vendor, [expense({ total: 200 })]).mismatch, false);
  assert.equal(contract.contractExpenseSummary(vendor, []).mismatch, false);
  assert.equal(contract.contractExpenseSummary({ ...vendor, contractTotal: null }, [expense()]).mismatch, false);
});

function screen() {
  let selection = { selectedEvent: { event_id: "10" }, userId: "owner", status: "ready" };
  let expenseState = { data: [expense()], loading: false, error: null };
  const loads = [], routes = [];
  let retries = 0;
  const Card = () => null;
  const imports = {
    react: { useCallback: callback => callback, useMemo: callback => callback(),
      useState: initial => [typeof initial === "function" ? initial() : initial, () => {}] },
    "react/jsx-runtime": jsx,
    "react-router-dom": { useNavigate: () => path => routes.push(path) },
    "../../components/page": { EmptyState: () => null, ErrorState: () => null, LoadingState: () => null, PageHeader: () => null },
    "../../components/ui": { Button: () => null, Card: () => null, Icon: () => null, Modal: () => null },
    "../../hooks/useResource": { useResource: loader => {
      loads.push(loader);
      return String(loader).includes("expenseService")
        ? { ...expenseState, reload() { retries++; } }
        : { data: [vendor], loading: false, error: null, reload() {}, update() {} };
    } },
    "../events/EventsContext": { useEvents: () => selection },
    "../../routes/navigation": { pagePath: () => "/app/expenses" },
    "../../services/vendorRules": load("services/vendorRules.ts"),
    "../../services/vendorService": { vendorService: { list: async eventId => eventId },
      VendorDeleteConflictError: class extends Error {}, VendorServiceError: class extends Error {}, VendorValidationError: class extends Error {} },
    "../../services/expenseService": { expenseService: { list: async eventId => eventId } },
    "./VendorActions": { VendorActions: () => null }, "./VendorCard": { VendorCard: Card },
    "./vendorFormat": { currency: value => value }, "./ContractExpensePrompt": { ContractExpensePrompt: () => null },
    "../../services/vendorExpenseContract": contract, "./VendorDrawer": { VendorDrawer: () => null },
    "./VendorForm": { VendorForm: () => null },
  };
  const { Vendors } = load("features/vendors/Vendors.tsx", imports);
  const wrapper = () => Vendors({ onToast() {} });
  const render = () => { const child = wrapper(); return child.type(child.props); };
  return { render, wrapper, loads, routes, retries: () => retries,
    select: value => { selection = value; }, state: value => { expenseState = value; },
    card: () => find(render(), node => node.type === Card),
  };
}
test("vendor cards compare saved totals while preserving API payment figures and link to the vendor filter", async () => {
  const h = screen();
  const card = h.card();
  assert.equal(card.props.vendor.paidTotal, "25.00");
  assert.equal(card.props.vendor.balance, "175.00");
  assert.ok(find(card.props.expenseAction, node => node.type === "dd" && node.props.children === "100.00"));
  find(card.props.expenseAction, node => node.props?.children === "Review expense breakdown").props.onClick();
  assert.deepEqual(h.routes, ["/app/expenses?vendorId=90"]);
  assert.deepEqual(await Promise.all(h.loads.map(loader => loader())), ["10", "10"]);
});
test("expense loading/failure hides comparison values and retries without hiding vendor cards", () => {
  const h = screen();
  h.state({ data: null, loading: true, error: null });
  assert.equal(h.card().props.expenseAction, undefined);
  h.state({ data: [expense()], loading: false, error: new Error("unavailable") });
  assert.equal(h.card().props.expenseAction, undefined);
  const failure = find(h.render(), node => node.props?.onRetry);
  failure.props.onRetry(); assert.equal(h.retries(), 1);
  h.state({ data: [expense({ total: 200 })], loading: false, error: null });
  assert.ok(find(h.card().props.expenseAction, node => Array.isArray(node.props?.children) && node.props.children.includes("View linked expenses (")));
});
test("changing event or account mounts a separate vendor page so old snapshots and dialogs cannot leak", () => {
  const h = screen(), first = h.wrapper();
  h.select({ selectedEvent: { event_id: "20" }, userId: "owner", status: "ready" });
  const second = h.wrapper(); assert.notEqual(second.key, first.key);
  h.select({ selectedEvent: { event_id: "20" }, userId: "other", status: "ready" });
  assert.notEqual(h.wrapper().key, second.key);
});
