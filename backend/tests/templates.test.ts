import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { createAppServer } from "../server";
import { db } from "../shared/db/db";
import { closePool, getPool } from "../shared/db/pool";

const server = createAppServer();
let baseUrl: string;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await closePool();
});

for (const id of ["abc", "0", "-1", "1.5", "1e2", "18446744073709551616"]) {
  test(`invalid template ID ${id} returns 400 without querying MySQL`, async () => {
    const response = await fetch(`${baseUrl}/event-templates/${id}`);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json() as { error: string }).error, "string");
  });
}

const integration = { skip: process.env.TEST_MYSQL !== "1" };
test("MySQL: list returns all five seeded types and matches database records", integration, async () => {
  const response = await fetch(`${baseUrl}/event-templates`);
  assert.equal(response.status, 200);
  const { templates } = await response.json() as { templates: { templateKey: string }[] };
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT CAST(template_id AS CHAR) AS templateId, template_key AS templateKey, name, description
     FROM event_templates ORDER BY template_id`,
  );
  assert.deepEqual(templates, rows.map(row => ({ ...row })));
  for (const key of ["wedding", "baby_shower", "birthday", "corporate", "other"]) {
    assert.ok(templates.some(template => template.templateKey === key), key);
  }
});

test("MySQL: details read category values and ordering from MySQL; defaults total 100%", integration, async () => {
  const [templates] = await getPool().query<RowDataPacket[]>(
    "SELECT CAST(template_id AS CHAR) AS id FROM event_templates WHERE template_key IN ('wedding','baby_shower','birthday','corporate','other')",
  );
  assert.equal(templates.length, 5);
  for (const row of templates) {
    const response = await fetch(`${baseUrl}/event-templates/${row.id}`);
    assert.equal(response.status, 200);
    const { template } = await response.json() as { template: { templateId: string; categories: { defaultPercentage: string }[] } };
    assert.equal(template.templateId, row.id);
    const [categories] = await getPool().query<RowDataPacket[]>(
      `SELECT CAST(template_category_id AS CHAR) AS templateCategoryId, name,
       default_percentage AS defaultPercentage, sort_order AS sortOrder
       FROM template_budget_categories WHERE template_id = ? ORDER BY sort_order, template_category_id`, [row.id],
    );
    assert.ok(categories.length > 0);
    assert.deepEqual(template.categories, categories.map(category => ({ ...category })));
    assert.equal(template.categories.reduce((sum, category) => sum + Math.round(Number(category.defaultPercentage) * 100), 0), 10000);
  }
});

test("MySQL: nonexistent valid ID returns 404", integration, async () => {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT CAST(COALESCE(MAX(template_id), 0) + 1 AS CHAR) AS id FROM event_templates",
  );
  const response = await fetch(`${baseUrl}/event-templates/${rows[0].id}`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Template not found" });
});


test("templates and authenticated event repositories share the existing MySQL pool", () => {
  assert.equal(getPool(), db);
});
