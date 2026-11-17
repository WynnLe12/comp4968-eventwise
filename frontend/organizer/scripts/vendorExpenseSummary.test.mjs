import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

function load(path, imports = {}, fetchRequest = globalThis.fetch) {
  const source = readFileSync(new URL("../src/" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", compiled)(name => {
    if (name.endsWith(".css")) return {};
    assert.ok(name in imports, "Unexpected import: " + name);
    return imports[name];
  }, module, module.exports, fetchRequest);
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
  const loads = [], routes = [], creates = [], syncs = [], vendorUpdates = [];
  let syncFailure = null;
  const states = []; let stateIndex = 0, vendorReloads = 0;
  let vendorData = [vendor];
  let retries = 0;
  const Card = () => null;
  const imports = {
    react: { useCallback: callback => callback, useMemo: callback => callback(),
      useState: initial => { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; } },
    "react/jsx-runtime": jsx,
    "react-router-dom": { useNavigate: () => path => routes.push(path) },
    "../../components/page": { EmptyState: () => null, ErrorState: () => null, LoadingState: () => null, PageHeader: () => null },
    "../../components/ui": { Button: () => null, Card: () => null, Icon: () => null, Modal: () => null },
    "../../hooks/useResource": { useResource: loader => {
      loads.push(loader);
      return String(loader).includes("expenseService")
        ? { ...expenseState, reload() { retries++; }, update(change) { expenseState = { ...expenseState, data: change(expenseState.data) }; } }
        : { data: vendorData, loading: false, error: null, reload() { vendorReloads++; }, update(change) { vendorData = change(vendorData); } };
    } },
    "../events/EventsContext": { useEvents: () => selection },
    "../../routes/navigation": { pagePath: () => "/app/expenses" },
    "../../services/vendorRules": load("services/vendorRules.ts"),
    "../../services/vendorService": { vendorService: { list: async () => vendorData,
      update: async (eventId, vendorId, input) => { vendorUpdates.push({ eventId, vendorId, input }); return { ...vendor, ...input }; },
      updateBoth: async (eventId, vendorId, input, link) => { syncs.push({ eventId, vendorId, input, link }); if (syncFailure) throw syncFailure; return { ...vendor, ...input }; } },
      VendorDeleteConflictError: class extends Error {}, VendorServiceError: class extends Error {}, VendorValidationError: class extends Error {} },
    "../../services/expenseService": { ExpenseSaveError: class extends Error {}, expenseService: { list: async () => expenseState.data,
      create: async (eventId, input) => { creates.push({ eventId, input }); return { id: "99", eventId, vendorId: input.vendorId, categoryId: input.categoryId, total: Number(input.committedAmount), paid: 0 }; } } },
    "../expenses/ExpenseForm": { ExpenseForm: () => null },
    "./VendorActions": { VendorActions: () => null }, "./VendorCard": { VendorCard: Card },
    "./vendorFormat": { currency: value => value }, "./ContractExpensePrompt": { ContractExpensePrompt: () => null },
    "../../services/vendorExpenseContract": contract, "./VendorDrawer": { VendorDrawer: () => null },
    "./VendorForm": { VendorForm: () => null },
  };
  const { Vendors } = load("features/vendors/Vendors.tsx", imports);
  const wrapper = () => Vendors({ onToast() {} });
  const render = () => { stateIndex = 0; const child = wrapper(); return child.type(child.props); };
  return { render, wrapper, loads, routes, creates, syncs, vendorUpdates,
    failSync: error => { syncFailure = error; },
    openEdit() { this.card().props.actions.props.onEdit(); },
    editForm: () => find(render(), node => node.props?.onSubmit && node.props?.vendor), vendorReloads: () => vendorReloads,
    form: () => find(render(), node => node.props?.initialDraft),
    prompt: () => find(render(), node => node.props?.onChoose && node.props?.vendor),
    expenseData: () => expenseState.data,
    retries: () => retries,
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
  find(card.props.expenseAction, node => Array.isArray(node.props?.children) && node.props.children.includes("View expenses (")).props.onClick();
  assert.deepEqual(h.routes, ["/app/expenses?vendorId=90"]);
  assert.deepEqual(await Promise.all(h.loads.map(loader => loader())), [[vendor], [expense()]]);
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
  assert.ok(find(h.card().props.expenseAction, node => Array.isArray(node.props?.children) && node.props.children.includes("View expenses (")));
});
test("changing event or account mounts a separate vendor page so old snapshots and dialogs cannot leak", () => {
  const h = screen(), first = h.wrapper();
  h.select({ selectedEvent: { event_id: "20" }, userId: "owner", status: "ready" });
  const second = h.wrapper(); assert.notEqual(second.key, first.key);
  h.select({ selectedEvent: { event_id: "20" }, userId: "other", status: "ready" });
  assert.notEqual(h.wrapper().key, second.key);
});


test("the contract expense offer requires a booked contract with no saved linked expenses", () => {
  assert.equal(contract.canAddContractExpense(vendor, []), true);
  assert.equal(contract.canAddContractExpense(vendor, [expense()]), false);
  assert.equal(contract.canAddContractExpense({ ...vendor, bookingStatus: "QUOTED" }, []), false);
  assert.equal(contract.canAddContractExpense({ ...vendor, contractStatus: "CANCELLED" }, []), false);
  assert.equal(contract.canAddContractExpense({ ...vendor, contractTotal: null }, []), false);
  assert.equal(contract.canAddContractExpense(vendor), false);
});
test("Not now preserves the vendor without creating an expense; proceeding prefills a category-required form", async () => {
  const h = screen(); h.state({ data: [], loading: false, error: null });
  h.card().props.expenseAction.props.onClick();
  h.prompt().props.onClose();
  assert.equal(h.creates.length, 0); assert.equal(h.prompt(), undefined);
  h.card().props.expenseAction.props.onClick(); h.prompt().props.onChoose("create");
  const form = h.form();
  assert.equal(form.props.eventId, "10"); assert.equal(form.props.accountId, "owner");
  assert.equal(form.props.defaultVendorId, "90"); assert.equal(form.props.lockVendor, true);
  assert.deepEqual(form.props.initialDraft, { name: "Photographer contract", amount: "200.00" });
  await form.props.onSave({ eventId: "10", vendorId: "90", categoryId: "123", vendor: "Photographer contract", total: 200, dueDate: "2026-12-01" });
  assert.deepEqual(h.creates, [{ eventId: "10", input: { categoryId: "123", vendorId: "90", description: "Photographer contract", committedAmount: "200.00", dueDate: "2026-12-01" } }]);
  assert.equal(h.expenseData()[0].id, "99"); assert.equal(h.form(), undefined);
  assert.equal(h.vendorReloads(), 1);
  assert.ok(h.card().props.expenseAction);
  assert.notEqual(h.card().props.expenseAction.props.children, "Add contract to expenses");
});
test("a newly discovered linked expense blocks a second full-contract creation and keeps the draft open", async () => {
  const h = screen(); h.state({ data: [], loading: false, error: null });
  h.card().props.expenseAction.props.onClick(); h.prompt().props.onChoose("create");
  const form = h.form();
  h.state({ data: [expense()], loading: false, error: null });
  await assert.rejects(form.props.onSave({ eventId: "10", vendorId: "90", categoryId: "123", vendor: "Contract", total: 200 }), /already has a linked expense/);
  assert.equal(h.creates.length, 0); assert.ok(h.form());
  await assert.rejects(form.props.onSave({ eventId: "20", vendorId: "90", categoryId: "123", vendor: "Contract", total: 200 }), /own event/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
test("Update both plans from saved expenses and uses one atomic call with expected totals", async () => {
  const h = screen(); h.openEdit();
  const pending = h.editForm().props.onSubmit({ contractTotal: "250.00" }); await tick();
  assert.equal(h.prompt().props.plan.mode, "single");
  h.prompt().props.onChoose("sync"); await pending;
  assert.deepEqual(h.syncs, [{ eventId: "10", vendorId: "90", input: { contractTotal: "250.00" }, link: {
    expenseId: "1", expectedContractTotal: "200.00", expectedExpenseTotal: "100.00"
  } }]);
  assert.equal(h.vendorUpdates.length, 0); assert.equal(h.editForm(), undefined);
});
test("Keep expense unchanged saves only the vendor; Cancel saves neither", async () => {
  for (const choice of ["keep", null]) {
    const h = screen(); h.openEdit();
    const pending = h.editForm().props.onSubmit({ contractTotal: "250.00" }); await tick();
    if (choice === null) h.prompt().props.onClose(); else h.prompt().props.onChoose(choice);
    await pending;
    assert.equal(h.syncs.length, 0); assert.equal(h.vendorUpdates.length, choice === null ? 0 : 1);
    if (choice === null) assert.ok(h.editForm());
  }
});
test("multiple linked expenses are reviewed; a failed atomic update retains the vendor draft", async () => {
  const multiple = screen(); multiple.state({ data: [expense(), expense({ id: "2" })], loading: false, error: null });
  multiple.openEdit();
  const review = multiple.editForm().props.onSubmit({ contractTotal: "250.00" }); await tick();
  assert.equal(multiple.prompt().props.plan.mode, "multiple");
  multiple.prompt().props.onChoose("review"); await review;
  assert.equal(multiple.syncs.length, 0); assert.equal(multiple.vendorUpdates.length, 1);
  assert.deepEqual(multiple.routes, ["/app/expenses?vendorId=90"]);
  const failed = screen(); failed.failSync(new Error("Contract changed. Reopen it.")); failed.openEdit();
  const pending = failed.editForm().props.onSubmit({ contractTotal: "250.00" }); await tick();
  failed.prompt().props.onChoose("sync");
  assert.match((await pending).message, /Contract changed/);
  assert.ok(failed.editForm()); assert.equal(failed.vendorUpdates.length, 0);
});
test("the real vendor adapter sends a single dedicated request and never falls back to sequential writes", async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const { vendorService } = load("services/vendorService.ts", {
      "../features/auth/services/authService": { requireAuthSession: async () => ({ session: { tokens: { accessToken: { toString: () => "test-token" } } } }) },
      "./apiConfig": { apiUrl: path => "/api" + path },
    }, async (url, request) => {
      calls.push({ url, ...request });
      return fail ? { status: 404, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => vendor };
    });
    const link = { expenseId: "1", expectedContractTotal: "200.00", expectedExpenseTotal: "100.00" };
    const pending = vendorService.updateBoth("10", "90", { contractTotal: "250.00" }, link);
    if (fail) await assert.rejects(pending, /update both records/); else await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/events/10/vendors/90/contract-expense");
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].body), { ...link, vendorChanges: { contractTotal: "250.00" } });
  }
});
