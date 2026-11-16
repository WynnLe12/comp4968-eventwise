import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const awsBase = "https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod";
function load(path, imports = {}, env = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")
    .replaceAll("import.meta.env", JSON.stringify(env));
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)(name => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
function client(env) {
  const config = load("services/apiConfig.ts", {}, env);
  return { config, api: load("services/eventTemplates.ts", { "./apiConfig": config }, env) };
}

test("AWS catalog override preserves the shared Events/Budget API base", () => {
  const { config, api } = client({ VITE_API_BASE_URL: "/api", VITE_TEMPLATES_API_BASE_URL: `${awsBase}/` });
  assert.equal(api.templateApiUrl("/event-templates"), `${awsBase}/event-templates`);
  assert.equal(config.apiUrl("/events"), "/api/events");
  assert.equal(config.apiUrl("/events/1/budget"), "/api/events/1/budget");
});

test("catalog falls back to shared base and the local proxy when no override exists", () => {
  assert.equal(client({ VITE_API_BASE_URL: "https://example.com/dev/" }).api.templateApiUrl("/event-templates"), "https://example.com/dev/event-templates");
  assert.equal(client({}).api.templateApiUrl("/event-templates"), "/api/event-templates");
});

test("AWS catalog requests preserve decimal strings, category order, and abort signals", async t => {
  const categories = [
    { templateCategoryId: "901", name: "Venue", defaultPercentage: "42.00", sortOrder: 1 },
    { templateCategoryId: "905", name: "Other", defaultPercentage: "58.00", sortOrder: 2 },
  ];
  const template = { templateId: "701", templateKey: "wedding", name: "Wedding", description: null };
  const details = { ...template, categories };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("/701") ? { template: details } : { templates: [template] });
  });
  const { api } = client({ VITE_TEMPLATES_API_BASE_URL: awsBase });
  const controller = new AbortController();
  assert.deepEqual(await api.listEventTemplates(controller.signal), [template]);
  assert.deepEqual(await api.getEventTemplate("701", controller.signal), details);
  assert.deepEqual(calls.map(call => call.url), [`${awsBase}/event-templates`, `${awsBase}/event-templates/701`]);
  for (const call of calls) assert.equal(call.options.signal, controller.signal);
});

test("empty catalog and empty details remain empty without mock defaults", async t => {
  t.mock.method(globalThis, "fetch", async url => Response.json(url.endsWith("/701") ? { template: { templateId: "701", categories: [] } } : { templates: [] }));
  const { api } = client({ VITE_TEMPLATES_API_BASE_URL: awsBase });
  assert.deepEqual(await api.listEventTemplates(), []);
  assert.deepEqual((await api.getEventTemplate("701")).categories, []);
});

test("HTTP errors, non-JSON replies, and network failures reach existing retry UI", async t => {
  const fetch = t.mock.method(globalThis, "fetch");
  const { api } = client({ VITE_TEMPLATES_API_BASE_URL: awsBase });
  fetch.mock.mockImplementation(async () => Response.json({ error: "unavailable" }, { status: 503 }));
  await assert.rejects(api.listEventTemplates(), /Template request failed \(503\)/);
  fetch.mock.mockImplementation(async () => new Response("<html>offline</html>", { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(api.getEventTemplate("701"), /did not return JSON/);
  fetch.mock.mockImplementation(async () => { throw new TypeError("Network unavailable"); });
  await assert.rejects(api.listEventTemplates(), /Network unavailable/);
});

test("blank override restores both local Templates endpoints", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url);
    return Response.json(url.endsWith("/8") ? { template: { templateId: "8", categories: [] } } : { templates: [] });
  });
  const { api } = client({ VITE_API_BASE_URL: "/api", VITE_TEMPLATES_API_BASE_URL: " " });
  await api.listEventTemplates();
  await api.getEventTemplate("8");
  assert.deepEqual(calls, ["/api/event-templates", "/api/event-templates/8"]);
});
