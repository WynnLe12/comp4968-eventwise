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
