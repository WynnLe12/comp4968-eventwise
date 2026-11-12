import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function loadModule(path, imports, replacements = {}) {
  let source = readFileSync(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
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

const first = {
  event_id: "9007199254740993", template_id: null, name: "First event", event_date: "2028-02-29",
  venue: "Garden", total_budget: "123.45", role: "OWNER",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};
const second = { ...first, event_id: "2", name: "Second event", role: "CO_PLANNER" };
const identity = { user: { userId: "user-a" }, session: { tokens: { accessToken: { toString: () => "access-token-a" } } } };

async function withApi(fetch, run, overrides = {}) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const api = loadModule("../src/features/events/services/eventApi.ts", {
      "../../../services/apiConfig": { apiUrl: (path) => `/api${path}` },
      "../../auth/services/authService": {
        requireAuthSession: async () => identity,
        getCurrentUser: async () => identity.user,
        ...overrides,
      },
    });
    await run(api);
  } finally { globalThis.fetch = previous; }
}

test("list API sends the Cognito access token to GET /api/events and preserves exact IDs, amounts, roles", async () => {
  const controller = new AbortController();
  await withApi(async (url, options) => {
    assert.equal(url, "/api/events");
    assert.deepEqual(options.headers, { Authorization: "Bearer access-token-a" });
    assert.equal(options.signal, controller.signal);
    assert.equal(options.method, undefined); // fetch defaults to GET
    return Response.json([first, second]);
  }, async (api) => {
    assert.deepEqual(await api.listEvents(controller.signal), { userId: "user-a", events: [first, second] });
    assert.deepEqual(api.parseEvents([]), []);
    assert.deepEqual(api.parseEvents([{ ...first, cognito_sub: "must-not-leak" }]), [first]);
  });
});

test("empty backend results stay empty, without mock events", async () => {
  await withApi(async () => Response.json([]), async (api) => {
    assert.deepEqual(await api.listEvents(), { userId: "user-a", events: [] });
  });
});

test("expired sessions/401 never return cached events and authentication failures skip fetch", async () => {
  await withApi(async () => new Response("", { status: 401 }), async (api) => {
    await assert.rejects(api.listEvents(), api.EventSessionError);
  });
  await withApi(async () => { assert.fail("fetch must not run"); }, async (api) => {
    await assert.rejects(api.listEvents(), api.EventSessionError);
  }, { requireAuthSession: async () => { throw new Error("Expired"); } });
});

test("API, network, and malformed response failures do not produce fallback event data", async () => {
  for (const fetch of [async () => new Response("private SQL info", { status: 500 }), async () => { throw new Error("Offline"); }, async () => new Response("not JSON")]) {
    await withApi(fetch, async (api) => { await assert.rejects(api.listEvents()); });
  }
  await withApi(async () => Response.json([first]), async (api) => {
    for (const body of [{ events: [first] }, [null], [{ ...first, event_id: 42 }], [{ ...first, event_id: "18446744073709551616" }], [{ ...first, role: "ADMIN" }]]) {
      assert.throws(() => api.parseEvents(body));
    }
  });
});

test("an account change during the API request discards the old account's events", async () => {
  await withApi(async () => Response.json([first]), async (api) => {
    await assert.rejects(api.listEvents(), /account changed/);
  }, { getCurrentUser: async () => ({ userId: "user-b" }) });
});

async function withListHook(run) {
  const previousWindow = globalThis.window;
  const requests = [];
  const refs = [];
  let refIndex = 0;
  let state;
  let initialized = false;
  const effects = [];
  const callbacks = [];
  let effectIndex = 0;
  let callbackIndex = 0;
  let pendingEffects = [];
  let onAuth;
  let focus;
  let unsubscribed = false;
  let expired = 0;
  class EventSessionError extends Error {}
  globalThis.window = {
    addEventListener: (name, listener) => { assert.equal(name, "focus"); focus = listener; },
    removeEventListener: (name, listener) => { assert.equal(name, "focus"); assert.equal(listener, focus); },
  };
  try {
    const api = loadModule("../src/features/events/EventsContext.tsx", {
      react: {
        createContext: () => ({}), useContext: () => null,
        useCallback: (callback, deps) => {
          const index = callbackIndex++;
          if (!callbacks[index] || deps.some((dep, i) => dep !== callbacks[index].deps[i])) callbacks[index] = { callback, deps };
          return callbacks[index].callback;
        },
        useState: (initial) => {
          if (!initialized) { state = initial; initialized = true; }
          return [state, (next) => { state = typeof next === "function" ? next(state) : next; }];
        },
        useRef: (initial) => { const index = refIndex++; refs[index] ??= { current: initial }; return refs[index]; },
        useEffect: (callback, deps) => {
          const index = effectIndex++;
          const previous = effects[index];
          if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
            pendingEffects.push(() => {
              previous?.cleanup?.();
              effects[index] = { deps, cleanup: callback() };
            });
          }
        },
      },
      "react/jsx-runtime": {},
      "aws-amplify/utils": { Hub: { listen: (channel, listener) => {
        assert.equal(channel, "auth"); onAuth = listener; return () => { unsubscribed = true; };
      } } },
      "./components/EditEventModal": { EditEventModal: () => null },
      "./hooks/useEventDetails": { useEventDetails: () => ({}) },
      "./services/eventApi": { EventSessionError, listEvents: (signal) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal })) },
    });
    const render = () => {
      refIndex = 0;
      effectIndex = 0;
      callbackIndex = 0;
      const result = api.useEventList(() => { expired++; });
      const scheduled = pendingEffects;
      pendingEffects = [];
      for (const effect of scheduled) effect();
      return result;
    };
    render();
    const cleanup = () => { for (const effect of effects) effect?.cleanup?.(); };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const auth = (event) => onAuth({ payload: { event } });
    try { await run({ render, requests, settle, auth, focus: () => focus(), cleanup, EventSessionError, expired: () => expired }); }
    finally { cleanup(); }
    assert.ok(unsubscribed);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("event selection is shared, rejects foreign IDs, and survives refresh only for the same account", async () => {
  await withListHook(async ({ render, requests, settle, auth }) => {
    assert.equal(render().status, "loading");
    requests[0].resolve({ userId: "user-a", events: [first, second] });
    await settle();
    assert.deepEqual(render().selectedEvent, first);
    render().selectEvent(second.event_id);
    assert.deepEqual(render().selectedEvent, second);
    render().selectEvent("unrelated-event");
    assert.deepEqual(render().selectedEvent, second);
    const refresh = render().refresh();
    assert.equal(render().selectedEvent, null);
    requests[1].resolve({ userId: "user-a", events: [first, second] });
    await refresh;
    assert.deepEqual(render().selectedEvent, second);
    auth("signedIn");
    assert.deepEqual(render().events, []);
    requests[2].resolve({ userId: "user-b", events: [first, { ...second, role: "OWNER" }] });
    await settle();
    assert.deepEqual(render().selectedEvent, first); // account A's selected ID did not carry over
  });
});

test("empty/error states clear events and support retry, while session errors notify the app", async () => {
  await withListHook(async ({ render, requests, settle, expired, EventSessionError }) => {
    requests[0].resolve({ userId: "user-a", events: [] });
    await settle();
    assert.equal(render().status, "empty");
    assert.deepEqual(render().events, []);
    assert.equal(render().selectedEvent, null);
    const retry = render().refresh();
    requests[1].reject(new Error("private server details"));
    await retry;
    assert.equal(render().status, "error");
    assert.doesNotMatch(render().error, /private/);
    const retryAgain = render().refresh();
    requests[2].resolve({ userId: "user-a", events: [first] });
    await retryAgain;
    assert.equal(render().status, "ready");
    const refresh = render().refresh();
    requests[3].reject(new EventSessionError("Sign in again"));
    await refresh;
    assert.equal(render().selectedEvent, null);
    assert.equal(expired(), 1);
  });
});

test("logout, refresh failures, and unmount abort requests and ignore late responses", async () => {
  await withListHook(async ({ render, requests, settle, auth, cleanup, focus }) => {
    auth("signedOut");
    assert.ok(requests[0].signal.aborted);
    requests[0].resolve({ userId: "old-user", events: [first] });
    await settle();
    assert.equal(render().selectedEvent, null);
    auth("signedIn");
    requests[1].resolve({ userId: "new-user", events: [second] });
    await settle();
    assert.deepEqual(render().selectedEvent, second);
    auth("tokenRefresh_failure");
    assert.deepEqual(render().events, []);
    focus();
    cleanup();
    assert.ok(requests[2].signal.aborted);
    requests[2].resolve({ userId: "old-user", events: [first] });
    await settle();
    assert.equal(render().selectedEvent, null);
  });
});

test("refresh removes an inaccessible selected event instead of retaining it", async () => {
  await withListHook(async ({ render, requests, settle }) => {
    requests[0].resolve({ userId: "user-a", events: [first, second] });
    await settle();
    render().selectEvent(second.event_id);
    const refresh = render().refresh();
    requests[1].resolve({ userId: "user-a", events: [first] });
    await refresh;
    assert.deepEqual(render().selectedEvent, first);
  });
});


const ui = {
  Icon: () => React.createElement("i"),
  Card: ({ children, className }) => React.createElement("div", { className }, children),
  Badge: ({ children }) => React.createElement("span", null, children),
  Button: ({ children, onClick }) => React.createElement("button", { onClick }, children),
};
const page = {
  PageHeader: ({ page, action }) => React.createElement("header", null, React.createElement("h1", null, page), action),
  LoadingState: ({ label }) => React.createElement("p", null, label),
  EmptyState: ({ title, message, action }) => React.createElement("section", null, title, message, action),
  StatCard: ({ label, value, detail }) => React.createElement("div", null, label, value, detail),
};
const presentation = loadModule("../src/features/events/eventPresentation.ts", {});

test("the existing switcher and profile show the selected event's name and actual role", () => {
  let state = { events: [first, second], selectedEvent: second, eventDetails: second, detailsStatus: "ready", status: "ready", selectEvent: () => {} };
  const layout = loadModule("../src/components/layout.tsx", {
    react: React, "react/jsx-runtime": jsxRuntime,
    "../routes/navigation": { navGroups: [] }, "./ui": ui,
    "../features/auth/hooks/useUserProfile": { useUserProfile: () => ({ profile: { displayName: "Signed-in user", initials: "SU" }, loading: false }) },
    "../features/events/EventsContext": { useEvents: () => state },
    "../features/events/eventPresentation": presentation,
  });
  // Use the actual JSX runtime so nested child arrays are rendered correctly.
  const sidebar = renderToStaticMarkup(React.createElement(layout.Sidebar, { page: "dashboard", setPage: () => {}, open: false, close: () => {} }));
  assert.match(sidebar, /Second event/);
  assert.match(sidebar, /Co-planner/);
  assert.match(sidebar, /<select/);
  assert.doesNotMatch(sidebar, /Maya|68%/);
  const topbar = renderToStaticMarkup(React.createElement(layout.Topbar, { toggleMenu: () => {}, goAlerts: () => {}, exit: () => {} }));
  assert.match(topbar, /Signed-in user/);
  assert.match(topbar, /Co-planner/);
  state = { ...state, events: [], selectedEvent: null, eventDetails: null, status: "empty" };
  const empty = renderToStaticMarkup(React.createElement(layout.Sidebar, { page: "dashboard", setPage: () => {}, open: false, close: () => {} }));
  assert.match(empty, /No events/);
  assert.match(empty, /disabled/);
  assert.doesNotMatch(empty, /First event|Second event|Maya/);
});

test("event workspace renders loading, empty, retry, and unavailable states instead of mock feature data", () => {
  let state = { status: "loading", detailsStatus: "ready", error: "", refresh: () => {} };
  const api = loadModule("../src/features/events/EventWorkspace.tsx", {
    "react/jsx-runtime": jsxRuntime,
    "../../components/page": page, "../../components/ui": ui,
    "./EventsContext": { useEvents: () => state },
  });
  const render = (currentPage = "dashboard") => renderToStaticMarkup(React.createElement(api.EventWorkspace, { page: currentPage }, "LIVE CONTENT"));
  assert.match(render(), /Loading your events/);
  state = { ...state, status: "empty" };
  assert.match(render(), /No events yet/);
  assert.doesNotMatch(render(), /LIVE CONTENT/);
  state = { ...state, status: "error", error: "Unable to load events" };
  assert.match(render(), /Try again/);
  state = { ...state, status: "ready" };
  assert.match(render(), /LIVE CONTENT/);
  assert.match(render("vendors"), /not available for this event/);
  assert.doesNotMatch(render("vendors"), /LIVE CONTENT/);
});


test("route callback changes and rerenders do not refetch events or reset the chosen event", async () => {
  await withListHook(async ({ render, requests, settle }) => {
    requests[0].resolve({ userId: "user-a", events: [first, second] });
    await settle();
    render().selectEvent(second.event_id);
    for (let i = 0; i < 3; i++) assert.deepEqual(render().selectedEvent, second);
    assert.equal(requests.length, 1);
  });
});


test("create API posts only event fields with the access token and accepts the backend's role-free 201 response", async () => {
  const { role: _role, ...created } = first;
  const input = { name: "  New event  ", template_id: "2", event_date: "2028-02-29", venue: "Garden", total_budget: "123.45" };
  await withApi(async (url, options) => {
    assert.equal(url, "/api/events");
    assert.equal(options.method, "POST");
    assert.deepEqual(options.headers, { "Content-Type": "application/json", Authorization: "Bearer access-token-a" });
    assert.deepEqual(JSON.parse(options.body), { ...input, name: "New event" });
    return Response.json(created, { status: 201 });
  }, async (api) => {
    assert.deepEqual(await api.createEvent(input), { userId: "user-a", event: created });
    assert.deepEqual(api.validateCreateEvent({ name: "Only name" }), { name: "Only name", template_id: null, event_date: null, venue: null });
    assert.deepEqual(api.validateCreateEvent({ name: String.fromCodePoint(0x1f389).repeat(150), venue: "x".repeat(255), total_budget: "9999999999.99", template_id: "18446744073709551615" }).template_id, "18446744073709551615");
  });
});

test("invalid create fields and identity/ownership fields fail before authentication or fetch", async () => {
  const invalid = [null, [], {}, { name: " " }, { name: "x".repeat(151) },
    { name: "Event", template_id: "0" }, { name: "Event", template_id: "18446744073709551616" },
    { name: "Event", event_date: "2027-02-29" }, { name: "Event", event_date: "2028-04-31" },
    { name: "Event", event_date: "0999-01-01" }, { name: "Event", event_date: "2028-01-01T00:00:00Z" },
    { name: "Event", venue: "x".repeat(256) }, { name: "Event", venue: 1 },
    { name: "Event", total_budget: "-1" }, { name: "Event", total_budget: "0.001" },
    { name: "Event", total_budget: "10000000000" }, { name: "Event", total_budget: null },
    { name: "Event", cognito_sub: "someone" }, { name: "Event", role: "OWNER" }, { name: "Event", event_id: "2" }];
  await withApi(async () => { assert.fail("fetch must not run"); }, async (api) => {
    for (const body of invalid) await assert.rejects(api.createEvent(body), api.EventValidationError);
  }, { requireAuthSession: async () => { assert.fail("Authentication should follow validation"); } });
});

test("create errors are safe and useful, and expired sessions cannot create events", async () => {
  for (const status of [400, 500]) {
    await withApi(async () => Response.json({ error: "private SQL details" }, { status }), async (api) => {
      await assert.rejects(api.createEvent({ name: "Event" }), (error) => error instanceof api.EventCreateError && !error.message.includes("private"));
    });
  }
  await withApi(async () => Response.json({ error: "template_id does not exist" }, { status: 400 }), async (api) => {
    await assert.rejects(api.createEvent({ name: "Event", template_id: "4" }), /template does not exist/);
  });
  await withApi(async () => new Response("", { status: 401 }), async (api) => {
    await assert.rejects(api.createEvent({ name: "Event" }), api.EventSessionError);
  });
  await withApi(async () => { assert.fail("fetch must not run"); }, async (api) => {
    await assert.rejects(api.createEvent({ name: "Event" }), api.EventSessionError);
  }, { requireAuthSession: async () => { throw new Error("Expired"); } });
});

test("a new event is selected from the refreshed list, including from an initially empty account", async () => {
  await withListHook(async ({ render, requests, settle }) => {
    requests[0].resolve({ userId: "user-a", events: [] });
    await settle();
    const refresh = render().refresh({ userId: "user-a", id: second.event_id });
    requests[1].resolve({ userId: "user-a", events: [first, second] });
    assert.equal(await refresh, true);
    assert.deepEqual(render().selectedEvent, second);
    const failedRefresh = render().refresh({ userId: "user-a", id: "missing" });
    requests[2].resolve({ userId: "user-a", events: [first] });
    assert.equal(await failedRefresh, false);
  });
});

async function withCreateHook(run) {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  const effects = [];
  let effectIndex = 0;
  const scheduled = [];
  const requests = [];
  let auth;
  let completed = 0;
  let closed = 0;
  let expired = 0;
  let refreshCount = 0;
  let refreshSuccess = true;
  class EventCreateError extends Error {}
  class EventValidationError extends Error {}
  class EventSessionError extends Error {}
  const options = {
    onCreated: async (result) => { assert.equal(result.event.event_id, first.event_id); refreshCount++; return refreshSuccess; },
    onComplete: () => { completed++; }, onClose: () => { closed++; }, onSessionExpired: () => { expired++; },
  };
  const api = loadModule("../src/features/events/hooks/useCreateEvent.ts", {
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => { states[index] = value; }];
      },
      useRef: (initial) => { const index = refIndex++; refs[index] ??= { current: initial }; return refs[index]; },
      useEffect: (callback, deps) => {
        const index = effectIndex++;
        if (!effects[index] || deps.some((dep, i) => dep !== effects[index].deps[i])) scheduled.push(() => {
          effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
        });
      },
    },
    "aws-amplify/utils": { Hub: { listen: (_channel, listener) => { auth = listener; return () => {}; } } },
    "../services/eventApi": {
      EventCreateError, EventValidationError, EventSessionError,
      createEvent: (body, signal) => new Promise((resolve, reject) => requests.push({ body, signal, resolve, reject })),
    },
  });
  const render = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0;
    const result = api.useCreateEvent(options);
    while (scheduled.length) scheduled.shift()();
    return result;
  };
  const cleanup = () => { for (const effect of effects) effect?.cleanup?.(); };
  try {
    render();
    await run({ render, requests, cleanup, auth: (event) => auth({ payload: { event } }),
      counts: () => ({ completed, closed, expired, refreshCount }),
      setRefreshSuccess: (value) => { refreshSuccess = value; },
      EventValidationError, EventSessionError,
    });
  } finally { cleanup(); }
}

test("create submission blocks double-clicks and modal closing while pending", async () => {
  await withCreateHook(async ({ render, requests, counts }) => {
    const pending = render().submit({ name: "Event" });
    await render().submit({ name: "Event" });
    render().close();
    assert.equal(requests.length, 1);
    assert.equal(render().loading, true);
    assert.equal(counts().closed, 0);
    requests[0].resolve({ userId: "user-a", event: first });
    await pending;
    assert.equal(counts().completed, 1);
    assert.equal(counts().refreshCount, 1);
  });
});

test("a failed list refresh retries GET/select after creation and never repeats POST", async () => {
  await withCreateHook(async ({ render, requests, counts, setRefreshSuccess }) => {
    setRefreshSuccess(false);
    const pending = render().submit({ name: "Event" });
    requests[0].resolve({ userId: "user-a", event: first });
    await pending;
    assert.equal(render().created, true);
    assert.match(render().error, /event was created/);
    assert.equal(counts().completed, 0);
    setRefreshSuccess(true);
    await render().submit({ name: "Changed fields must not POST" });
    assert.equal(requests.length, 1);
    assert.equal(counts().refreshCount, 2);
    assert.equal(counts().completed, 1);
  });
});

test("create validation/errors stay in the modal and session failures notify the app", async () => {
  await withCreateHook(async ({ render, requests, counts, EventValidationError, EventSessionError }) => {
    let pending = render().submit({ name: "" });
    requests[0].reject(new EventValidationError("Event name is required"));
    await pending;
    assert.match(render().error, /name is required/);
    assert.equal(counts().refreshCount, 0);
    pending = render().submit({ name: "Event" });
    requests[1].reject(new Error("private connection details"));
    await pending;
    assert.doesNotMatch(render().error, /private/);
    pending = render().submit({ name: "Event" });
    requests[2].reject(new EventSessionError("Please sign in"));
    await pending;
    assert.equal(counts().expired, 1);
    assert.equal(counts().completed, 0);
  });
});

test("logout or account changes abort submission and ignore late creation results", async () => {
  await withCreateHook(async ({ render, requests, counts, auth }) => {
    const pending = render().submit({ name: "Event" });
    auth("signedOut");
    assert.equal(counts().closed, 1);
    assert.ok(requests[0].signal.aborted);
    requests[0].resolve({ userId: "old-user", event: first });
    await pending;
    assert.equal(counts().completed, 0);
    assert.equal(counts().refreshCount, 0);
  });
});


test("the reused create modal starts blank, uses a real submit form, and displays pending/retry states", () => {
  let submission = { loading: false, created: false, error: "", submit: () => {}, close: () => {} };
  const Field = loadModule("../src/components/ui/Field.tsx", { "react/jsx-runtime": jsxRuntime }).Field;
  const Button = loadModule("../src/components/ui/Button.tsx", { "react/jsx-runtime": jsxRuntime, "./Icon": { Icon: ui.Icon } }).Button;
  const api = loadModule("../src/features/events/components/CreateEventModal.tsx", {
    react: React, "react/jsx-runtime": jsxRuntime,
    "../../../components/ui": { ...ui, Field, Button, Modal: ({ title, children, footer }) => React.createElement("div", null, title, children, footer) },
    "../../../services/eventTemplates": { listEventTemplates: async () => [], getEventTemplate: async () => null },
    "../utils/budgetPreview": loadModule("../src/features/events/utils/budgetPreview.ts", {}),
    "../hooks/useCreateEvent": { useCreateEvent: () => submission },
  });
  const render = () => renderToStaticMarkup(React.createElement(api.CreateEventModal, {}));
  assert.match(render(), /id="create-event-form"/);
  assert.match(render(), /type="submit"[^>]*form="create-event-form"/);
  assert.doesNotMatch(render(), /Maya|Test Wedding|20000/);
  assert.match(render(), /value=""/);
  submission = { ...submission, loading: true };
  assert.match(render(), /Please wait/);
  assert.match(render(), /disabled/);
  submission = { ...submission, loading: false, created: true, error: "Your event was created. Retry loading." };
  assert.match(render(), /Retry loading event/);
  assert.match(render(), /role="alert"/);
});


test("detail API requests the selected BIGINT ID with the access token and parses the single-event response", async () => {
  const controller = new AbortController();
  await withApi(async (url, options) => {
    assert.equal(url, `/api/events/${first.event_id}`);
    assert.equal(options.method, undefined);
    assert.deepEqual(options.headers, { Authorization: "Bearer access-token-a" });
    assert.equal(options.signal, controller.signal);
    return Response.json({ ...first, template_id: "7", role: "CO_PLANNER", cognito_sub: "not-exposed" });
  }, async (api) => {
    assert.deepEqual(await api.getEventDetails(first.event_id, controller.signal), {
      userId: "user-a", event: { ...first, template_id: "7", role: "CO_PLANNER" },
    });
  });
});

test("detail API maps 401, 403, 404 and server failures without exposing response internals", async () => {
  for (const status of [401, 403, 404, 500]) {
    await withApi(async () => Response.json({ error: "private SQL details" }, { status }), async (api) => {
      await assert.rejects(api.getEventDetails("1"), (error) => {
        assert.doesNotMatch(error.message, /private/);
        if (status === 401) return error instanceof api.EventSessionError;
        return error instanceof api.EventDetailsError && error.status === status;
      });
    });
  }
});

test("detail API rejects invalid IDs, unexpected response envelopes, and mismatched events", async () => {
  await withApi(async () => { assert.fail("fetch must not run"); }, async (api) => {
    for (const id of ["0", "-1", "1.5", "18446744073709551616", "1/2"]) await assert.rejects(api.getEventDetails(id), api.EventDetailsError);
  });
  for (const body of [{ event: first }, [first], second, { ...first, role: "ADMIN" }]) {
    await withApi(async () => Response.json(body), async (api) => { await assert.rejects(api.getEventDetails(first.event_id)); });
  }
  await withApi(async () => Response.json(first), async (api) => {
    await assert.rejects(api.getEventDetails(first.event_id), /account changed/);
  }, { getCurrentUser: async () => ({ userId: "user-b" }) });
});

async function withDetailsHook(run) {
  const states = [];
  const refs = [];
  const effects = [];
  const callbacks = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, callbackIndex = 0;
  const scheduled = [];
  const requests = [];
  let onAuth;
  let expired = 0;
  let eventId = first.event_id;
  let userId = "user-a";
  class EventSessionError extends Error {}
  class EventDetailsError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const api = loadModule("../src/features/events/hooks/useEventDetails.ts", {
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
      useRef: (initial) => { const index = refIndex++; refs[index] ??= { current: initial }; return refs[index]; },
      useCallback: (callback, deps) => {
        const index = callbackIndex++;
        if (!callbacks[index] || deps.some((dep, i) => dep !== callbacks[index].deps[i])) callbacks[index] = { callback, deps };
        return callbacks[index].callback;
      },
      useEffect: (callback, deps) => {
        const index = effectIndex++;
        if (!effects[index] || deps.some((dep, i) => dep !== effects[index].deps[i])) scheduled.push(() => {
          effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
        });
      },
    },
    "aws-amplify/utils": { Hub: { listen: (_channel, listener) => { onAuth = listener; return () => {}; } } },
    "../services/eventApi": {
      EventSessionError, EventDetailsError,
      getEventDetails: (id, signal) => new Promise((resolve, reject) => requests.push({ id, signal, resolve, reject })),
    },
  });
  const render = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0; callbackIndex = 0;
    const result = api.useEventDetails(eventId, userId, () => { expired++; });
    while (scheduled.length) scheduled.shift()();
    return result;
  };
  const cleanup = () => { for (const effect of effects) effect?.cleanup?.(); };
  try {
    render();
    await run({ render, requests, cleanup, EventDetailsError, EventSessionError,
      select: (id, user = userId) => { eventId = id; userId = user; },
      settle: () => new Promise((resolve) => setImmediate(resolve)),
      auth: (event) => onAuth({ payload: { event } }), expired: () => expired,
    });
  } finally { cleanup(); }
}

test("event details load and switching clears previous data before the next effect completes", async () => {
  await withDetailsHook(async ({ render, requests, select, settle }) => {
    assert.equal(render().detailsStatus, "loading");
    requests[0].resolve({ userId: "user-a", event: first });
    await settle();
    assert.deepEqual(render().eventDetails, first);
    select(second.event_id);
    assert.equal(render().eventDetails, null);
    assert.ok(requests[0].signal.aborted);
    assert.equal(requests[1].id, second.event_id);
    requests[1].resolve({ userId: "user-a", event: second });
    await settle();
    assert.deepEqual(render().eventDetails, second);
  });
});

test("late responses and failures from a previous selected event cannot overwrite the current details", async () => {
  await withDetailsHook(async ({ render, requests, select, settle }) => {
    select(second.event_id);
    render();
    requests[1].resolve({ userId: "user-a", event: second });
    await settle();
    requests[0].resolve({ userId: "user-a", event: first });
    await settle();
    assert.deepEqual(render().eventDetails, second);
    render().reloadDetails(); render();
    select(first.event_id); render();
    requests[3].resolve({ userId: "user-a", event: first });
    await settle();
    requests[2].reject(new Error("late old request"));
    await settle();
    assert.deepEqual(render().eventDetails, first);
  });
});

test("detail authorization errors clear event data and support retry while 401 notifies authentication", async () => {
  await withDetailsHook(async ({ render, requests, settle, EventDetailsError, EventSessionError, expired }) => {
    requests[0].reject(new EventDetailsError(403, "You no longer have access"));
    await settle();
    assert.equal(render().detailsErrorStatus, 403);
    assert.equal(render().eventDetails, null);
    render().reloadDetails(); render();
    requests[1].reject(new EventDetailsError(404, "Event no longer exists"));
    await settle();
    assert.equal(render().detailsErrorStatus, 404);
    render().reloadDetails(); render();
    requests[2].resolve({ userId: "user-a", event: first });
    await settle();
    assert.deepEqual(render().eventDetails, first);
    render().reloadDetails(); render();
    requests[3].reject(new EventSessionError("Please sign in"));
    await settle();
    assert.equal(render().eventDetails, null);
    assert.equal(expired(), 1);
  });
});

test("logout, account switching, and cleanup discard in-flight detail responses", async () => {
  await withDetailsHook(async ({ render, requests, select, settle, auth, cleanup }) => {
    auth("signedOut");
    assert.ok(requests[0].signal.aborted);
    requests[0].resolve({ userId: "user-a", event: first });
    await settle();
    assert.equal(render().eventDetails, null);
    select(first.event_id, "user-b"); render();
    requests[1].resolve({ userId: "user-b", event: { ...first, role: "CO_PLANNER" } });
    await settle();
    assert.equal(render().eventDetails.role, "CO_PLANNER");
    select(null, null);
    assert.equal(render().eventDetails, null);
    assert.equal(render().detailsStatus, "idle");
    select(second.event_id, "user-b"); render();
    cleanup();
    requests[2].resolve({ userId: "user-b", event: second });
    await settle();
    assert.equal(render().eventDetails, null);
  });
});

test("the dashboard uses detail data and available template ID without fabricating statistics", () => {
  const detailed = { ...first, name: "Detail response name", template_id: "7", total_budget: "456.78", venue: "Detail venue", role: "CO_PLANNER" };
  const api = loadModule("../src/features/dashboard/Dashboard.tsx", {
    "react/jsx-runtime": jsxRuntime, "../../components/ui": ui, "../../components/page": page,
    "../events/EventsContext": { useEvents: () => ({ selectedEvent: second, eventDetails: detailed, openCreate: () => {} }) },
    "../events/eventPresentation": presentation,
  });
  const html = renderToStaticMarkup(React.createElement(api.Dashboard, { go: () => {} }));
  assert.match(html, /Detail response name/);
  assert.match(html, /Detail venue/);
  assert.match(html, /456.78/);
  assert.match(html, /Template ID: 7/);
  assert.match(html, /Co-planner/);
  assert.doesNotMatch(html, /Second event|35000|120 guests|68%/);
  assert.match(html, /Spending information is not available/);
});


test("detail loading and authorization errors hide dashboard content but keep event switching accessible", () => {
  let state = { status: "ready", detailsStatus: "loading", detailsError: "", detailsErrorStatus: null, refresh: () => {}, reloadDetails: () => {} };
  const api = loadModule("../src/features/events/EventWorkspace.tsx", {
    "react/jsx-runtime": jsxRuntime, "../../components/page": page, "../../components/ui": ui,
    "./EventsContext": { useEvents: () => state },
  });
  const render = (currentPage = "dashboard") => renderToStaticMarkup(React.createElement(api.EventWorkspace, { page: currentPage }, "EVENT CONTENT"));
  assert.match(render(), /Loading event details/);
  assert.doesNotMatch(render(), /EVENT CONTENT/);
  for (const status of [403, 404]) {
    state = { ...state, detailsStatus: "error", detailsErrorStatus: status, detailsError: "Select another event or refresh your events." };
    assert.match(render(), /Refresh events/);
    assert.match(render(), /role="alert"/);
    assert.doesNotMatch(render(), /EVENT CONTENT/);
    assert.match(render("events"), /EVENT CONTENT/);
  }
});


test("edit API PATCHes only changed allowed fields with the current access token", async () => {
  const changed = { ...first, name: "Renamed event", venue: null };
  await withApi(async (url, options) => {
    assert.equal(url, `/api/events/${first.event_id}`);
    assert.equal(options.method, "PATCH");
    assert.deepEqual(options.headers, { "Content-Type": "application/json", Authorization: "Bearer access-token-a" });
    assert.deepEqual(JSON.parse(options.body), { name: "Renamed event", venue: null });
    return Response.json(changed);
  }, async (api) => {
    const draft = { ...api.eventEditDraft(first), name: "Renamed event", venue: "" };
    const patch = api.buildEventPatch(first, draft);
    assert.deepEqual(await api.updateEvent(first.event_id, patch, undefined, "user-a"), { userId: "user-a", event: changed });
  });
});

test("edit draft preserves actual values and unchanged fields including decimal formatting are omitted", async () => {
  await withApi(async () => { assert.fail("No request expected"); }, async (api) => {
    const draft = api.eventEditDraft(first);
    assert.deepEqual(draft, { name: first.name, template_id: "", event_date: "2028-02-29", venue: "Garden", total_budget: "123.45" });
    assert.deepEqual(api.buildEventPatch(first, draft), {});
    assert.deepEqual(api.buildEventPatch(first, { ...draft, name: ` ${first.name} ` }), {});
    assert.deepEqual(api.buildEventPatch({ ...first, total_budget: "123.40" }, { ...draft, total_budget: "123.4" }), {});
    assert.deepEqual(api.buildEventPatch(first, { ...draft, event_date: "", venue: "", template_id: "7" }), { template_id: "7", event_date: null, venue: null });
    await assert.rejects(api.updateEvent(first.event_id, {}), api.EventValidationError);
  });
});

test("edit validation rejects invalid/protected fields and event IDs before requests", async () => {
  const invalid = [null, [], {}, { name: " " }, { name: null }, { name: "x".repeat(151) },
    { template_id: "0" }, { template_id: "18446744073709551616" }, { event_date: "2027-02-29" },
    { event_date: "2028-04-31" }, { event_date: "0999-01-01" }, { venue: "x".repeat(256) },
    { total_budget: null }, { total_budget: "-1" }, { total_budget: "0.001" }, { total_budget: "10000000000" },
    { event_id: "1" }, { cognito_sub: "attacker" }, { role: "OWNER" }, { updated_at: "2028-01-01" }];
  await withApi(async () => { assert.fail("fetch must not run"); }, async (api) => {
    for (const patch of invalid) await assert.rejects(api.updateEvent(first.event_id, patch), api.EventValidationError);
    for (const id of ["0", "-1", "1.5", "18446744073709551616"]) await assert.rejects(api.updateEvent(id, { name: "New" }), api.EventValidationError);
  });
});

test("edit API maps 400/401/403/404/500 safely and rejects account changes before PATCH", async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    await withApi(async () => Response.json({ error: "private SQL details" }, { status }), async (api) => {
      await assert.rejects(api.updateEvent(first.event_id, { name: "New" }), (error) => {
        assert.doesNotMatch(error.message, /private/);
        return status === 401 ? error instanceof api.EventSessionError : error instanceof api.EventUpdateError && error.status === status;
      });
    });
  }
  await withApi(async () => Response.json({ error: "template_id does not exist" }, { status: 400 }), async (api) => {
    await assert.rejects(api.updateEvent(first.event_id, { template_id: "7" }), /template does not exist/);
  });
  await withApi(async () => { assert.fail("fetch must not run for another account"); }, async (api) => {
    await assert.rejects(api.updateEvent(first.event_id, { name: "New" }, undefined, "user-b"), /account changed/);
  });
});

async function withEditHook(run, original = first) {
  const states = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const scheduled = [], requests = [];
  let onAuth, completed = 0, closed = 0, expired = 0, refreshed = 0;
  let current = true, refreshSuccess = true;
  class EventSessionError extends Error {}
  class EventValidationError extends Error {}
  class EventUpdateError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const options = {
    userId: "user-a", isCurrent: () => current,
    onUpdated: async (result) => { assert.equal(result.userId, "user-a"); refreshed++; return refreshSuccess; },
    onComplete: () => { completed++; }, onClose: () => { closed++; }, onSessionExpired: () => { expired++; },
  };
  const api = loadModule("../src/features/events/hooks/useEditEvent.ts", {
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => { states[index] = value; }];
      },
      useRef: (initial) => { const index = refIndex++; refs[index] ??= { current: initial }; return refs[index]; },
      useEffect: (callback, deps) => {
        const index = effectIndex++;
        if (!effects[index] || deps.some((dep, i) => dep !== effects[index].deps[i])) scheduled.push(() => {
          effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
        });
      },
    },
    "aws-amplify/utils": { Hub: { listen: (_channel, callback) => { onAuth = callback; return () => {}; } } },
    "../services/eventApi": {
      EventSessionError, EventValidationError, EventUpdateError,
      buildEventPatch: (_event, draft) => draft,
      updateEvent: (id, patch, signal, userId) => new Promise((resolve, reject) => requests.push({ id, patch, signal, userId, resolve, reject })),
    },
  });
  const render = () => {
    stateIndex = 0; refIndex = 0; effectIndex = 0;
    const result = api.useEditEvent(original, options);
    while (scheduled.length) scheduled.shift()();
    return result;
  };
  const cleanup = () => { for (const effect of effects) effect?.cleanup?.(); };
  try {
    render();
    await run({ render, requests, cleanup, auth: (event) => onAuth({ payload: { event } }),
      counts: () => ({ completed, closed, expired, refreshed }), setCurrent: (value) => { current = value; },
      setRefreshSuccess: (value) => { refreshSuccess = value; }, EventSessionError, EventUpdateError,
    });
  } finally { cleanup(); }
}

test("edit saves once, prevents duplicate clicks, and refreshes before closing", async () => {
  await withEditHook(async ({ render, requests, counts }) => {
    const pending = render().submit({ name: "New" });
    await render().submit({ name: "New" });
    render().close();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, first.event_id);
    assert.equal(requests[0].userId, "user-a");
    assert.equal(render().loading, true);
    assert.equal(counts().closed, 0);
    requests[0].resolve({ userId: "user-a", event: { ...first, name: "New" } });
    await pending;
    assert.equal(counts().refreshed, 1);
    assert.equal(counts().completed, 1);
  });
});

test("cancel and unchanged values send no PATCH, and co-planners cannot submit", async () => {
  await withEditHook(async ({ render, requests, counts }) => {
    render().close();
    assert.equal(counts().closed, 1);
    await render().submit({});
    assert.match(render().error, /No changes/);
    assert.equal(requests.length, 0);
  });
  await withEditHook(async ({ render, requests }) => {
    await render().submit({ name: "New" });
    assert.equal(requests.length, 0);
    assert.equal(render().blocked, true);
  }, second);
});

test("saved changes retry refresh only without repeating PATCH", async () => {
  await withEditHook(async ({ render, requests, counts, setRefreshSuccess }) => {
    setRefreshSuccess(false);
    const pending = render().submit({ name: "New" });
    requests[0].resolve({ userId: "user-a", event: first });
    await pending;
    assert.equal(render().saved, true);
    assert.match(render().error, /changes were saved/);
    setRefreshSuccess(true);
    await render().submit({ name: "Different" });
    assert.equal(requests.length, 1);
    assert.equal(counts().refreshed, 2);
    assert.equal(counts().completed, 1);
  });
});

test("edit 403/404 block more saves, while 401 notifies authentication and server errors stay safe", async () => {
  for (const status of [403, 404]) await withEditHook(async ({ render, requests, EventUpdateError }) => {
    const pending = render().submit({ name: "New" });
    requests[0].reject(new EventUpdateError(status, "Not allowed"));
    await pending;
    assert.equal(render().blocked, true);
    await render().submit({ name: "Retry" });
    assert.equal(requests.length, 1);
  });
  await withEditHook(async ({ render, requests, counts, EventSessionError }) => {
    let pending = render().submit({ name: "New" });
    requests[0].reject(new Error("private SQL details"));
    await pending;
    assert.doesNotMatch(render().error, /private/);
    pending = render().submit({ name: "New" });
    requests[1].reject(new EventSessionError("Sign in again"));
    await pending;
    assert.equal(counts().expired, 1);
  });
});

test("switching events/accounts prevents late edit results from refreshing or replacing current data", async () => {
  await withEditHook(async ({ render, requests, counts, setCurrent }) => {
    const pending = render().submit({ name: "New" });
    setCurrent(false);
    requests[0].resolve({ userId: "user-a", event: first });
    await pending;
    assert.equal(counts().refreshed, 0);
    assert.equal(counts().completed, 0);
  });
  await withEditHook(async ({ render, requests, counts, auth }) => {
    const pending = render().submit({ name: "New" });
    auth("signedOut");
    assert.ok(requests[0].signal.aborted);
    requests[0].resolve({ userId: "user-a", event: first });
    await pending;
    assert.equal(counts().closed, 1);
    assert.equal(counts().refreshed, 0);
  });
});

test("only OWNER details display an Edit action, and the edit form uses real prefilled values", async () => {
  let event = first;
  const dashboard = loadModule("../src/features/dashboard/Dashboard.tsx", {
    "react/jsx-runtime": jsxRuntime, "../../components/ui": ui, "../../components/page": page,
    "../events/EventsContext": { useEvents: () => ({ eventDetails: event, openCreate: () => {}, openEdit: () => {} }) },
    "../events/eventPresentation": presentation,
  });
  assert.match(renderToStaticMarkup(React.createElement(dashboard.Dashboard, { go: () => {} })), /Edit event/);
  event = second;
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(dashboard.Dashboard, { go: () => {} })), /Edit event/);
  await withApi(async () => { assert.fail(); }, async (api) => {
    const Field = loadModule("../src/components/ui/Field.tsx", { "react/jsx-runtime": jsxRuntime }).Field;
    const Button = loadModule("../src/components/ui/Button.tsx", { "react/jsx-runtime": jsxRuntime, "./Icon": { Icon: ui.Icon } }).Button;
    const modal = loadModule("../src/features/events/components/EditEventModal.tsx", {
      react: React, "react/jsx-runtime": jsxRuntime,
      "../../../components/ui": { ...ui, Field, Button, Modal: ({ title, children, footer }) => React.createElement("div", null, title, children, footer) },
      "../services/eventApi": api,
      "../../../services/eventTemplates": { listEventTemplates: async () => [] },
      "../hooks/useEditEvent": { useEditEvent: () => ({ loading: false, saved: false, blocked: false, error: "", submit: () => {}, close: () => {} }) },
    });
    const html = renderToStaticMarkup(React.createElement(modal.EditEventModal, { event: first }));
    assert.match(html, /value="First event"/);
    assert.match(html, /value="2028-02-29"/);
    assert.match(html, /value="Garden"/);
    assert.match(html, /value="123.45"/);
    assert.match(html, /form="edit-event-form"/);
    assert.match(html, /disabled/); // unchanged Save is disabled
    assert.equal(renderToStaticMarkup(React.createElement(modal.EditEventModal, { event: second })), "");
  });
});


function templateForm(draft, details, submit, overrides = {}) {
  const values = [draft, [{ templateId: "42", templateKey: "birthday", name: "Birthday", description: null }], false, 0, details, null, 0];
  let index = 0;
  const form = loadModule("../src/features/events/components/CreateEventModal.tsx", {
    react: { ...React, useEffect: () => {}, useState: () => [values[index++], () => {}] },
    "react/jsx-runtime": jsxRuntime,
    "../../../components/ui": { ...ui, Modal: ({ children, footer }) => React.createElement("div", null, children, footer) },
    "../../../services/eventTemplates": { listEventTemplates: async () => [], getEventTemplate: async () => null },
    "../utils/budgetPreview": loadModule("../src/features/events/utils/budgetPreview.ts", {}),
    "../hooks/useCreateEvent": { useCreateEvent: () => ({ loading: false, created: false, error: "", close: () => {}, submit, ...overrides }) },
  });
  return { module: form, element: form.CreateEventModal({}) };
}
const previewTemplate = {
  templateId: "42", templateKey: "birthday", name: "Birthday", description: null,
  categories: [
    { templateCategoryId: "100", name: "Venue", defaultPercentage: "42.00", sortOrder: 1 },
    { templateCategoryId: "101", name: "Food", defaultPercentage: "58.00", sortOrder: 2 },
  ],
};

test("merged template dropdown draft submits the chosen templateId and totalBudget using the event API contract", async () => {
  const draft = { name: "Birthday dinner", templateId: "42", eventDate: "2028-02-29", venue: " Garden ", totalBudget: "100.01" };
  const { role: _role, ...created } = { ...first, name: draft.name, template_id: "42", total_budget: "100.01" };
  let submitted;
  await withApi(async (url, options) => {
    assert.equal(url, "/api/events");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { name: "Birthday dinner", template_id: "42", event_date: "2028-02-29", venue: "Garden", total_budget: "100.01" });
    return Response.json(created, { status: 201 });
  }, async (api) => {
    const form = templateForm(draft, previewTemplate, (body) => { submitted = api.createEvent(body); });
    form.element.props.children.props.onSubmit({ preventDefault() {} });
    assert.equal((await submitted).event.template_id, "42");
    const html = renderToStaticMarkup(form.element);
    assert.match(html, /<select/);
    assert.match(html, /Birthday/);
    assert.match(html, /42%/);
    assert.match(html, /42.00/);
    assert.match(html, /58.01/);
    assert.match(html, /Preview only/);
  });
});

test("stale, missing, or invalid template defaults cannot submit and saved-event retries remain available", () => {
  const draft = { name: "Birthday", templateId: "42", eventDate: "", venue: "", totalBudget: "0.01" };
  for (const details of [null, { ...previewTemplate, templateId: "other" }, { ...previewTemplate, categories: [] }]) {
    const form = templateForm(draft, details, () => { assert.fail("Cannot submit before valid defaults load"); });
    form.element.props.children.props.onSubmit({ preventDefault() {} });
  }
  let retried = false;
  const saved = templateForm(draft, null, () => { retried = true; }, { created: true });
  saved.element.props.children.props.onSubmit({ preventDefault() {} });
  assert.ok(retried);
});

test("template and event clients share the configured API base and preserve template response envelopes", async () => {
  const config = loadModule("../src/services/apiConfig.ts", {}, { "import.meta.env": JSON.stringify({ VITE_API_BASE_URL: "https://example.invalid/api/" }) });
  assert.equal(config.apiUrl("/events"), "https://example.invalid/api/events");
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json(url.endsWith("/42") ? { template: previewTemplate } : { templates: [previewTemplate] });
  };
  try {
    const client = loadModule("../src/services/eventTemplates.ts", { "./apiConfig": config });
    assert.deepEqual(await client.listEventTemplates(), [previewTemplate]);
    assert.deepEqual(await client.getEventTemplate("42"), previewTemplate);
    assert.deepEqual(calls, ["https://example.invalid/api/event-templates", "https://example.invalid/api/event-templates/42"]);
  } finally { globalThis.fetch = previous; }
});


function findElement(element, type) {
  if (!element || typeof element !== "object") return null;
  if (Array.isArray(element)) {
    for (const child of element) { const found = findElement(child, type); if (found) return found; }
    return null;
  }
  return element.type === type ? element : findElement(element.props?.children, type);
}

async function withEditTemplateForm(api, original, submit, run) {
  const states = [], effects = [], requests = [];
  let stateIndex = 0, effectIndex = 0;
  const scheduled = [];
  const Field = loadModule("../src/components/ui/Field.tsx", { "react/jsx-runtime": jsxRuntime }).Field;
  const Button = loadModule("../src/components/ui/Button.tsx", { "react/jsx-runtime": jsxRuntime, "./Icon": { Icon: ui.Icon } }).Button;
  const modal = loadModule("../src/features/events/components/EditEventModal.tsx", {
    react: {
      useState: (initial) => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
      },
      useEffect: (callback, deps) => {
        const index = effectIndex++;
        if (!effects[index] || deps.some((dep, i) => dep !== effects[index].deps[i])) scheduled.push(() => {
          effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() };
        });
      },
    },
    "react/jsx-runtime": jsxRuntime,
    "../../../components/ui": { ...ui, Field, Button, Modal: ({ children, footer }) => React.createElement("div", null, children, footer) },
    "../services/eventApi": api,
    "../../../services/eventTemplates": { listEventTemplates: (signal) => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })) },
    "../hooks/useEditEvent": { useEditEvent: () => ({ loading: false, saved: false, blocked: false, error: "", submit, close: () => {} }) },
  });
  const render = () => {
    stateIndex = 0; effectIndex = 0;
    const result = modal.EditEventModal({ event: original });
    while (scheduled.length) scheduled.shift()();
    return result;
  };
  const cleanup = () => { for (const effect of effects) effect?.cleanup?.(); };
  try {
    render();
    await run({ render, requests, cleanup, settle: () => new Promise((resolve) => setImmediate(resolve)) });
  } finally { cleanup(); }
}
const editTemplateCatalog = [
  { templateId: "701", templateKey: "first-type", name: "API event type A", description: null },
  { templateId: "902", templateKey: "second-type", name: "API event type B", description: null },
];

test("Edit preselects the saved template and changing the dropdown PATCHes its real ID only", async () => {
  const original = { ...first, template_id: "701" };
  let inFlight;
  let count = 0;
  await withApi(async (url, options) => {
    count++;
    assert.equal(url, `/api/events/${original.event_id}`);
    assert.equal(options.method, "PATCH");
    assert.deepEqual(JSON.parse(options.body), { template_id: "902" });
    return Response.json({ ...original, template_id: "902" });
  }, async (api) => {
    await withEditTemplateForm(api, original, (draft) => {
      const patch = api.buildEventPatch(original, draft);
      if (Object.keys(patch).length) inFlight = api.updateEvent(original.event_id, patch);
    }, async ({ render, requests, settle }) => {
      assert.equal(findElement(render(), "select").props.disabled, true);
      requests[0].resolve(editTemplateCatalog);
      await settle();
      let element = render();
      let select = findElement(element, "select");
      assert.equal(select.props.value, "701");
      const html = renderToStaticMarkup(element);
      assert.match(html, /value="701" selected=""/);
      assert.match(html, /API event type A/);
      assert.match(html, /API event type B/);
      assert.doesNotMatch(html, /Event type \(template ID\)/);
      findElement(element, "form").props.onSubmit({ preventDefault() {} });
      assert.equal(count, 0); // all fields, including the preselected template, are unchanged
      select.props.onChange({ target: { value: "902" } });
      element = render();
      assert.equal(findElement(element, "select").props.value, "902");
      findElement(element, "form").props.onSubmit({ preventDefault() {} });
      await inFlight;
      assert.equal(count, 1);
    });
  });
});

test("Edit keeps unchanged templates through catalog errors and retries without resetting other fields", async () => {
  const original = { ...first, template_id: "701" };
  let inFlight;
  await withApi(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { name: "Renamed while catalog unavailable" });
    return Response.json({ ...original, name: "Renamed while catalog unavailable" });
  }, async (api) => {
    await withEditTemplateForm(api, original, (draft) => {
      inFlight = api.updateEvent(original.event_id, api.buildEventPatch(original, draft));
    }, async ({ render, requests, settle }) => {
      requests[0].reject(new Error("private catalog details"));
      await settle();
      let element = render();
      assert.match(renderToStaticMarkup(element), /load event types/);
      assert.doesNotMatch(renderToStaticMarkup(element), /private catalog details/);
      assert.equal(findElement(element, "select").props.value, "701");
      const form = findElement(element, "form");
      const nameField = form.props.children.find((child) => child?.props?.label === "Event name");
      nameField.props.onChange({ target: { value: "Renamed while catalog unavailable" } });
      element = render();
      findElement(element, "form").props.onSubmit({ preventDefault() {} });
      await inFlight;
      // Retry button is in the form error block; it reuses the same template API.
      const alert = findElement(element, "form").props.children.find((child) => child?.props?.role === "alert");
      alert.props.children[1].props.onClick();
      render();
      assert.ok(requests[0].signal.aborted);
      requests[1].resolve(editTemplateCatalog);
      await settle();
      element = render();
      assert.equal(findElement(element, "select").props.value, "701");
      assert.match(renderToStaticMarkup(element), /Renamed while catalog unavailable/);
    });
  });
});

test("Edit handles deleted templates and an empty catalog without silently clearing the saved ID", async () => {
  const original = { ...first, template_id: "555" };
  await withApi(async () => { assert.fail("No request expected"); }, async (api) => {
    const drafts = [];
    await withEditTemplateForm(api, original, (draft) => drafts.push(draft), async ({ render, requests, settle }) => {
      requests[0].resolve([]);
      await settle();
      let element = render();
      assert.equal(findElement(element, "select").props.value, "555");
      assert.match(renderToStaticMarkup(element), /Current event type unavailable/);
      assert.match(renderToStaticMarkup(element), /No event types are available/);
      findElement(element, "form").props.onSubmit({ preventDefault() {} });
      assert.deepEqual(api.buildEventPatch(original, drafts[0]), {});
      findElement(element, "select").props.onChange({ target: { value: "" } });
      element = render();
      findElement(element, "form").props.onSubmit({ preventDefault() {} });
      assert.deepEqual(api.buildEventPatch(original, drafts[1]), { template_id: null });
    });
  });
});

test("Edit aborts catalog loading when closed and ignores late results", async () => {
  await withApi(async () => { assert.fail(); }, async (api) => {
    await withEditTemplateForm(api, first, () => {}, async ({ render, requests, cleanup, settle }) => {
      cleanup();
      requests[0].resolve(editTemplateCatalog);
      await settle();
      assert.ok(requests[0].signal.aborted);
      assert.equal(findElement(render(), "select").props.disabled, true);
    });
  });
});
