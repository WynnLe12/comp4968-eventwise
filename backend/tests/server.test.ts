import "./testEnvironment";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createAppServer } from "../server";

const server = createAppServer();
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("health endpoint returns JSON with an OK status", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("event deletion routes require authentication", async () => {
  const response = await fetch(`${baseUrl}/events/42`, { method: "DELETE" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Missing or invalid authentication token" });
});

test("unsupported health methods return 404", async () => {
  const response = await fetch(`${baseUrl}/health`, { method: "POST" });
  assert.equal(response.status, 404);
});
