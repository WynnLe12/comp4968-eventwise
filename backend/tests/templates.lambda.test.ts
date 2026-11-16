import assert from "node:assert/strict";
import { test } from "node:test";
import { createTemplatesHandler } from "../event-service/lambda/templates";
import type { TemplateRepository } from "../event-service/services/templates";

function fixture() {
  const ids: string[] = [];
  let lists = 0;
  const repository: TemplateRepository = {
    async listTemplates() { lists++; return []; },
    async getTemplate(id) { ids.push(id); return null; },
  };
  return { repository, ids, get lists() { return lists; } };
}

test("REST proxy list returns JSON envelope and supports warm repeated calls", async () => {
  const f = fixture();
  const handler = createTemplatesHandler(f.repository);
  for (let i = 0; i < 2; i++) {
    const result = await handler({ httpMethod: "GET", path: "/event-templates" });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["Content-Type"], "application/json");
    assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
    assert.equal(result.isBase64Encoded, false);
    assert.deepEqual(JSON.parse(result.body), { templates: [] });
  }
  assert.equal(f.lists, 2);
});

test("detail preserves string IDs and decimal values", async () => {
  const template = JSON.parse('{"templateId":"18446744073709551615","templateKey":"wedding","name":"Wedding","description":null,"categories":[{"templateCategoryId":"1","name":"Venue","defaultPercentage":"42.00","sortOrder":1}]}');
  const f = fixture();
  f.repository.getTemplate = async id => { assert.equal(id, template.templateId); return template; };
  const result = await createTemplatesHandler(f.repository)({ httpMethod: "GET", path: `/event-templates/${template.templateId}` });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
  assert.deepEqual(JSON.parse(result.body), { template });
});

for (const id of ["abc", "0", "-1", "1.5", "1e2", "01", "18446744073709551616"]) {
  test(`Lambda rejects ${id} before database access`, async () => {
    const f = fixture();
    const result = await createTemplatesHandler(f.repository)({ httpMethod: "GET", path: `/event-templates/${id}` });
    assert.equal(result.statusCode, 400);
    assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
    assert.deepEqual(f.ids, []);
    assert.equal(f.lists, 0);
  });
}

test("missing templates and unsupported requests return 404", async () => {
  const f = fixture();
  const handler = createTemplatesHandler(f.repository);
  const result = await handler({ httpMethod: "GET", path: "/event-templates/1" });
  assert.deepEqual(JSON.parse(result.body), { error: "Template not found" });
  assert.equal(result.statusCode, 404);
  assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
  for (const event of [
    { httpMethod: "POST", path: "/event-templates" },
    { httpMethod: "GET", path: "/events" },
    { httpMethod: "GET", path: "/event-templates/1/extra" },
  ]) {
    const response = await handler(event);
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["Access-Control-Allow-Origin"], "*");
  }
  assert.deepEqual(f.ids, ["1"]);
});

test("database failures are logged but not exposed, with CORS on errors", async t => {
  const log = t.mock.method(console, "error", () => {});
  const f = fixture();
  f.repository.listTemplates = async () => { throw new Error("private database details"); };
  const result = await createTemplatesHandler(f.repository)({ httpMethod: "GET", path: "/event-templates" });
  assert.equal(result.statusCode, 500);
  assert.deepEqual(JSON.parse(result.body), { error: "Internal server error" });
  assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(log.mock.callCount(), 1);
});

test("OPTIONS handles both template resources without database access", async () => {
  const f = fixture();
  const handler = createTemplatesHandler(f.repository);
  for (const path of ["/event-templates", "/event-templates/1"]) {
    const result = await handler({ httpMethod: "OPTIONS", path });
    assert.equal(result.statusCode, 204);
    assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
    assert.equal(result.body, "");
    assert.equal(result.headers["Access-Control-Allow-Methods"], "GET,OPTIONS");
  }
  assert.equal(f.lists, 0);
  assert.deepEqual(f.ids, []);
});

test("wildcard CORS is returned without an origin argument", async () => {
  const result = await createTemplatesHandler(fixture().repository)({ httpMethod: "GET", path: "/event-templates" });
  assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
});
