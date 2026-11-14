import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function load(path, imports = {}, replacements = {}) {
  let source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  const module = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", compiled)((name) => {
    if (name.endsWith(".css")) return {};
    assert.ok(name in imports, `Unexpected import ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const validation = load("features/events/utils/eventFormValidation.ts");
const api = load("features/events/services/eventApi.ts", {
  "../utils/eventFormValidation": validation,
  "../../../services/apiConfig": { apiUrl: (path) => `/api${path}` },
  "../../auth/services/authService": { requireAuthSession: async () => ({ user: { userId: "a" }, session: { tokens: { accessToken: "token" } } }), getCurrentUser: async () => ({ userId: "a" }) },
});
const saved = { event_id: "1", name: "Saved event", event_date: validation.localToday(), venue: "Saved venue", total_budget: "100.00", template_id: "42", role: "OWNER" };
const template = { templateId: "42", name: "Catalog event type", categories: [{ templateCategoryId: "1", name: "Venue", defaultPercentage: "100" }] };

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return null; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}

// Exercise actual form + submission hooks with controlled React state/effects and API promises.
function formHost(mode, original = saved) {
  const states = [], refs = [], effects = [], scheduled = [], requests = [];
  let si = 0, ri = 0, ei = 0, tree, closeCount = 0, successCount = 0;
  const react = {
    useState(initial) {
      const index = si++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(initial) { const index = ri++; return refs[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = ei++;
      if (!effects[index] || deps.some((dep, i) => dep !== effects[index].deps[i])) scheduled.push(() => {
        effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
      });
    },
  };
  const request = (body) => new Promise((resolve, reject) => requests.push({ body, resolve, reject }));
  const eventApi = { ...api, createEvent: request, updateEvent: (_id, body) => request(body) };
  const hookName = mode === "create" ? "useCreateEvent" : "useEditEvent";
  const hook = load(`features/events/hooks/${hookName}.ts`, {
    react, "aws-amplify/utils": { Hub: { listen: () => () => {} } }, "../services/eventApi": eventApi,
  });
  const { Field } = load("components/ui/Field.tsx", { react: React, "react/jsx-runtime": jsx });
  const Modal = ({ children, footer }) => React.createElement("div", null, children, footer);
  const Button = ({ variant: _variant, ...props }) => React.createElement("button", props);
  const component = load(`features/events/components/${mode === "create" ? "Create" : "Edit"}EventModal.tsx`, {
    react, "react/jsx-runtime": jsx, "../../../components/ui": { Field, Button, Modal },
    "../../../services/eventTemplates": { listEventTemplates: async () => [template], getEventTemplate: async () => template },
    "../services/eventApi": api, [`../hooks/${hookName}`]: hook,
    "../utils/eventFormValidation": validation,
    "../hooks/useEventValidation": load("features/events/hooks/useEventValidation.ts", { react }),
    "../utils/budgetPreview": load("features/events/utils/budgetPreview.ts"),
  });
  const props = { event: original, userId: "a", isCurrent: () => true, onCreated: async () => true, onUpdated: async () => true,
    onClose: () => closeCount++, onComplete: () => successCount++, onSessionExpired: () => {} };
  const render = () => {
    si = ri = ei = 0;
    tree = component[mode === "create" ? "CreateEventModal" : "EditEventModal"](props);
    while (scheduled.length) scheduled.shift()();
    return tree;
  };
  render();
  return {
    render, requests,
    html: () => renderToStaticMarkup(render()),
    field: (name) => find(render(), (node) => node.props?.name === name),
    change(name, value) { this.field(name).props.onChange({ target: { value } }); render(); },
    blur(name) { this.field(name).props.onBlur(); render(); },
    submit() { return find(render(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} }); },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); render(); },
    closeCount: () => closeCount, successCount: () => successCount,
    cleanup: () => { for (const effect of effects) effect?.cleanup?.(); },
  };
}

async function fillCreate(host, date = validation.localToday()) {
  host.change("name", "New event"); host.change("templateId", "42"); host.change("eventDate", date); host.change("totalBudget", "100");
  await host.settle();
}

test("local date-only validation accepts today/future and rejects past/empty/impossible dates", () => {
  assert.equal(validation.localToday({ getFullYear: () => 2028, getMonth: () => 1, getDate: () => 29, toISOString: () => "2028-03-01T01:00:00Z" }), "2028-02-29");
  for (const date of ["2028-03-01", "2028-03-02"]) assert.equal(validation.eventDateError(date, "2028-03-01"), undefined);
  assert.equal(validation.eventDateError("2028-02-29", "2028-03-01"), "Event date cannot be in the past.");
  assert.equal(validation.eventDateError("", "2028-03-01"), "Event date is required.");
  assert.equal(validation.eventDateError("2028-02-30", "2028-03-01"), "Enter a valid event date.");
});

test("Strict Mode focus setup/cleanup replay does not validate a freshly opened Event form", () => {
  const host = formHost("create");
  const previousDocument = globalThis.document;
  let effect, restores = 0, focuses = 0, refIndex = 0;
  const opener = { isConnected: true, focus() {
    restores++;
    // Focusing the opener blurs the automatically focused name field in a browser.
    host.blur("name");
    globalThis.document.activeElement = opener;
  } };
  const input = { isConnected: true, focus() { focuses++; globalThis.document.activeElement = input; } };
  const dialog = { isConnected: true, querySelector: () => input };
  globalThis.document = { activeElement: opener };
  try {
    const { Modal } = load("components/ui/Modal.tsx", {
      react: { useRef: (initial) => refIndex++ === 0 ? { current: dialog } : { current: initial }, useEffect: (callback) => { effect = callback; } },
      "react-dom": { createPortal: (node) => node }, "react/jsx-runtime": jsx, "./Icon": { Icon: () => null },
    }, { "document.body": "null" });
    Modal(host.render().props);
    const firstCleanup = effect();
    firstCleanup(); // Strict Mode replays effects while the dialog remains mounted.
    const finalCleanup = effect();
    assert.equal(focuses, 2);
    assert.equal(restores, 0);
    assert.doesNotMatch(host.html(), /Event name is required\.|expense-form-error|aria-invalid="true"/);
    host.change("name", "");
    assert.doesNotMatch(host.html(), /Event name is required\./); // No false touched state either.
    dialog.isConnected = false; input.isConnected = false;
    finalCleanup(); // Actual unmount must still restore the original opener.
    assert.equal(restores, 1);
    assert.equal(globalThis.document.activeElement, opener);
  } finally {
    host.cleanup();
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

for (const mode of ["create", "edit"]) {
  test(`${mode}: typing/blur show no errors before Submit/Save; invalid submit shows one summary; corrections clear it`, async () => {
    const host = formHost(mode);
    try {
      await host.settle();
      assert.doesNotMatch(host.html(), /expense-form-error|field-error|aria-invalid="true"/);
      assert.equal(host.field("eventDate").props.min, validation.localToday());
      host.change("name", ""); host.blur("name");
      assert.doesNotMatch(host.html(), /Event name is required\.|expense-form-error|aria-invalid="true"/);
      host.change("name", "Corrected");
      assert.doesNotMatch(host.html(), /Event name is required\./);
      host.change("name", ""); // Even previously blurred fields wait for Submit/Save.
      assert.doesNotMatch(host.html(), /Event name is required\./);
      host.change("eventDate", ""); host.change("totalBudget", "");
      await host.submit();
      assert.equal(host.requests.length, 0);
      assert.equal((host.html().match(/Please fix the highlighted fields and try again\./g) ?? []).length, 1);
      assert.match(host.html(), /Event date is required\./);
      assert.match(host.html(), /Total budget is required\./);
      if (mode === "create") assert.match(host.html(), /Please select an event type\./);
      host.change("name", "Corrected");
      assert.doesNotMatch(host.html(), /Event name is required\./);
      assert.match(host.html(), /expense-form-error/);
      host.change("eventDate", validation.localToday()); host.change("totalBudget", "100");
      if (mode === "create") host.change("templateId", "42");
      assert.doesNotMatch(host.html(), /expense-form-error|field-error|aria-invalid="true"/);
    } finally { host.cleanup(); }
  });

  for (const method of ["Cancel", "X", "Escape", "backdrop"]) test(`${mode}: ${method} discards errors, touched state, and unsaved draft`, async () => {
    const host = formHost(mode);
    try {
      host.change("name", ""); await host.submit();
      assert.match(host.html(), /expense-form-error/);
      const root = host.render();
      if (method === "Cancel") find(root.props.footer, (node) => node.props?.children === "Cancel").props.onClick();
      else {
        // Use the real Modal's close wiring without a browser portal/focus effect.
        const { Modal } = load("components/ui/Modal.tsx", { react: { useRef: () => ({ current: null }), useEffect() {} },
          "react-dom": { createPortal: (node) => node }, "react/jsx-runtime": jsx, "./Icon": { Icon: () => null } }, { "document.body": "null" });
        const dialog = Modal(root.props);
        if (method === "X") find(dialog, (node) => node.props?.["aria-label"] === "Close").props.onClick();
        if (method === "Escape") dialog.props.onKeyDown({ key: "Escape", stopPropagation() {} });
        if (method === "backdrop") dialog.props.onMouseDown();
      }
      assert.equal(host.closeCount(), 1);
      // Explicit cleanup also works before the parent's unmount is processed.
      assert.doesNotMatch(host.html(), /expense-form-error|field-error|aria-invalid="true"/);
      assert.equal(host.field("name").props.value, mode === "create" ? "" : saved.name);
      host.change("name", "");
      assert.doesNotMatch(host.html(), /Event name is required\./); // No touched state leaked.
    } finally { host.cleanup(); }
    const reopened = formHost(mode);
    try { assert.doesNotMatch(reopened.html(), /expense-form-error|field-error/); }
    finally { reopened.cleanup(); }
  });

  test(`${mode}: past date blocks writes, valid save prevents duplicates and resets on success`, async () => {
    const host = formHost(mode, { ...saved, event_date: "1000-01-01" });
    try {
      await host.settle();
      assert.doesNotMatch(host.html(), /field-error/); // Saved past dates are shown without immediate errors.
      if (mode === "create") await fillCreate(host, "1000-01-01");
      else host.change("name", "Updated event");
      await host.submit(); assert.equal(host.requests.length, 0);
      assert.match(host.html(), /Event date cannot be in the past\./);
      host.change("eventDate", validation.localToday());
      const pending = host.submit(); const duplicate = host.submit();
      assert.equal(host.requests.length, 1);
      assert.match(host.html(), /Please wait/);
      host.render().props.onClose(); assert.equal(host.closeCount(), 0); // Keep existing pending-write guard.
      host.requests[0].resolve({ userId: "a", event: saved });
      await Promise.all([pending, duplicate]);
      assert.equal(host.successCount(), 1);
      assert.doesNotMatch(host.html(), /expense-form-error|field-error/);
      assert.equal(host.field("name").props.value, mode === "create" ? "" : saved.name);
    } finally { host.cleanup(); }
  });

  test(`${mode}: backend field errors appear inline, preserve input, and clear on correction`, async () => {
    const host = formHost(mode);
    try {
      await host.settle();
      if (mode === "create") await fillCreate(host);
      else host.change("name", "Unsaved edit");
      const pending = host.submit();
      const fields = { venue: "Use 255 characters or fewer." };
      host.requests[0].reject(mode === "create" ? new api.EventCreateError("Validation", fields) : new api.EventUpdateError(400, "Validation", fields));
      await pending;
      assert.match(host.html(), /Use 255 characters or fewer\./);
      assert.match(host.html(), /expense-form-error/);
      assert.equal(host.field("name").props.value, mode === "create" ? "New event" : "Unsaved edit");
      host.change("venue", "Corrected venue");
      assert.doesNotMatch(host.html(), /expense-form-error|Use 255/);
      const retry = host.submit(); host.requests[1].reject(new Error("private database error")); await retry;
      assert.match(host.html(), /Unable to complete the request/);
      assert.doesNotMatch(host.html(), /private database/);
      assert.equal(host.field("venue").props.value, "Corrected venue");
    } finally { host.cleanup(); }
  });

  test(`${mode}: a future date saves with the selected API template ID`, async () => {
    const now = new Date();
    const future = validation.localToday(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const host = formHost(mode);
    try {
      await host.settle();
      if (mode === "create") await fillCreate(host, future);
      else host.change("eventDate", future);
      const pending = host.submit();
      assert.equal(host.requests.length, 1);
      assert.equal(host.requests[0].body.event_date, future);
      if (mode === "create") assert.equal(host.requests[0].body.template_id, "42");
      host.requests[0].resolve({ userId: "a", event: { ...saved, event_date: future } });
      await pending;
      assert.equal(host.successCount(), 1);
    } finally { host.cleanup(); }
  });
}

test("after a valid submission attempt, correcting new invalid values updates errors without another submit", async () => {
  const host = formHost("create");
  try {
    await host.settle(); await fillCreate(host);
    const pending = host.submit(); host.requests[0].reject(new Error("Offline")); await pending;
    host.change("venue", "x".repeat(256)); host.blur("venue");
    assert.match(host.html(), /Use 255 characters or fewer\./);
    assert.match(host.html(), /expense-form-error/);
    host.change("venue", "Valid venue");
    assert.doesNotMatch(host.html(), /expense-form-error|Use 255 characters/);
  } finally { host.cleanup(); }
});

test("the real EventsProvider unmounts editors on close, event/account switching, and opening Create", async () => {
  const previous = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const states = [], refs = [], effects = [], callbacks = [], scheduled = [];
  let si = 0, ri = 0, ei = 0, ci = 0, auth, creates = 0, closeCreates = 0;
  const events = [saved, { ...saved, event_id: "2", name: "Second event" }];
  const react = {
    createContext: () => ({ Provider: () => null }), useContext() {},
    useState(initial) {
      const index = si++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(initial) { const index = ri++; return refs[index] ??= { current: initial }; },
    useCallback(callback, deps) {
      const index = ci++;
      if (!callbacks[index] || deps.some((dep, i) => dep !== callbacks[index].deps[i])) callbacks[index] = { deps, callback };
      return callbacks[index].callback;
    },
    useEffect(callback, deps) {
      const index = ei++;
      if (!effects[index] || deps.some((dep, i) => dep !== effects[index].deps[i])) scheduled.push(() => {
        effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
      });
    },
  };
  const { EventsProvider } = load("features/events/EventsContext.tsx", {
    react, "react/jsx-runtime": jsx, "./services/eventApi": { ...api, listEvents: async () => ({ userId: "a", events }) },
    "aws-amplify/utils": { Hub: { listen: (_channel, listener) => { auth = listener; return () => {}; } } },
    "./hooks/useEventDetails": { useEventDetails: (id) => ({ eventDetails: events.find((event) => event.event_id === id) ?? null }) },
    "./components/EditEventModal": { EditEventModal: () => null },
  });
  const props = { children: null, onSessionExpired() {}, onCreate: () => creates++, onEdit: () => closeCreates++ };
  const render = () => {
    si = ri = ei = ci = 0;
    const node = EventsProvider(props);
    while (scheduled.length) scheduled.shift()();
    return node;
  };
  const editor = () => render().props.children[1];
  try {
    render(); await new Promise((resolve) => setImmediate(resolve));
    render().props.value.openEdit(); assert.equal(closeCreates, 1);
    assert.equal(editor().key, "a/1");
    editor().props.onClose(); assert.ok(!editor());
    render().props.value.openEdit();
    render().props.value.openCreate(); assert.equal(creates, 1); assert.ok(!editor());
    render().props.value.openEdit();
    render().props.value.selectEvent("2"); assert.ok(!editor());
    render().props.value.openEdit(); assert.equal(editor().key, "a/2");
    editor().props.onComplete(); assert.ok(!editor());
    render().props.value.openEdit(); auth({ payload: { event: "signedOut" } }); assert.ok(!editor());
  } finally {
    for (const effect of effects) effect?.cleanup?.();
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
});

test("separate event/account mounts and Create/Edit modes do not share draft or validation state", async () => {
  const first = formHost("edit");
  first.change("name", ""); await first.submit(); assert.match(first.html(), /expense-form-error/); first.cleanup();
  const second = formHost("edit", { ...saved, event_id: "2", name: "Other saved event" });
  assert.equal(second.field("name").props.value, "Other saved event");
  assert.doesNotMatch(second.html(), /expense-form-error|field-error/); second.cleanup();
  const create = formHost("create"); assert.equal(create.field("name").props.value, ""); assert.doesNotMatch(create.html(), /expense-form-error|field-error/); create.cleanup();
});

test("actual API clients map backend validation responses to the correct fields and ignore internal messages", async () => {
  const previous = globalThis.fetch;
  try {
    for (const [message, field] of [
      ["Event date cannot be in the past.", "event_date"], ["name is required and must contain at most 150 characters", "name"],
      ["template_id does not exist", "template_id"], ["venue must contain at most 255 characters or be null", "venue"],
      ["total_budget must be between 0 and 9999999999.99 with at most two decimal places", "total_budget"],
    ]) {
      globalThis.fetch = async () => Response.json({ error: message }, { status: 400 });
      for (const send of [() => api.createEvent({ name: "Event" }), () => api.updateEvent("1", { name: "Event" })]) {
        await assert.rejects(send(), (error) => Object.keys(error.fieldErrors).length === 1 && !!error.fieldErrors[field]);
      }
    }
    assert.deepEqual(validation.apiFieldErrors("SELECT private credentials"), {});
  } finally { globalThis.fetch = previous; }
});

test("Expense validation remains unchanged: required name, money checks, and past due dates", () => {
  const { validateExpenseDraft } = load("features/expenses/expenseDraft.ts", { "../../data/mockData": { CURRENT_EVENT_ID: "1" } });
  assert.equal(validateExpenseDraft({ name: "", amount: "0", dueDate: "" }).name, "Expense name is required.");
  assert.deepEqual(validateExpenseDraft({ name: "Venue", amount: "50.00", dueDate: "2020-01-01" }), {});
  assert.match(validateExpenseDraft({ name: "Venue", amount: "-1", dueDate: "" }).amount, /0 or more/);
});
