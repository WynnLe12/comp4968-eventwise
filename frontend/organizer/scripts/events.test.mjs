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
  PageHeader: ({ page }) => React.createElement("h1", null, page),
  LoadingState: ({ label }) => React.createElement("p", null, label),
  EmptyState: ({ title, message, action }) => React.createElement("section", null, title, message, action),
  StatCard: ({ label, value, detail }) => React.createElement("div", null, label, value, detail),
};
const presentation = loadModule("../src/features/events/eventPresentation.ts", {});

test("the existing switcher and profile show the selected event's name and actual role", () => {
  let state = { events: [first, second], selectedEvent: second, status: "ready", selectEvent: () => {} };
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
  state = { ...state, events: [], selectedEvent: null, status: "empty" };
  const empty = renderToStaticMarkup(React.createElement(layout.Sidebar, { page: "dashboard", setPage: () => {}, open: false, close: () => {} }));
  assert.match(empty, /No events/);
  assert.match(empty, /disabled/);
  assert.doesNotMatch(empty, /First event|Second event|Maya/);
});

test("event workspace renders loading, empty, retry, and unavailable states instead of mock feature data", () => {
  let state = { status: "loading", error: "", refresh: () => {} };
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
