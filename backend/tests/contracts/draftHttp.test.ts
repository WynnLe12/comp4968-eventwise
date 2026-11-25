import "../../tests/testEnvironment";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { ApiError } from "../../expense-service/errors";
import type { Draft, DraftReader } from "../../contract-service/types";
import { createAppServer } from "../../server";

const draft: Draft = {
  draftId: "9007199254740993", eventId: "12", documentId: "23",
  documentFilename: "contract.pdf", documentContentType: "application/pdf",
  description: "DJ contract", categoryId: null, vendorId: null, vendorName: "DJ",
  totalAmount: "5000.00", depositAmount: "1000.00", dueDate: null, currencyCode: null,
  saveAction: "CREATE_EXPENSE", targetExpenseId: null, confirmedExpenseId: null,
  version: "1", status: "DRAFT", createdAt: "2026-11-25 12:00:00",
  updatedAt: "2026-11-25 12:00:00", confirmedAt: null,
};
async function withServer(run: (url: string, calls: unknown[][]) => Promise<void>, failure?: Error) {
  const calls: unknown[][] = [];
  function authorize(eventId: string, sub: string) {
    if (failure) throw failure;
    if (eventId !== "12" || !["owner", "planner"].includes(sub)) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
  }
  const reader: DraftReader = {
    async list(eventId, sub, query) {
      calls.push(["list", eventId, sub, query]); authorize(eventId, sub);
      return { data: [draft], total: 1, limit: query.limit, offset: query.offset };
    },
    async get(eventId, id, sub) {
      calls.push(["get", eventId, id, sub]); authorize(eventId, sub);
      return id === draft.draftId ? draft : null;
    },
  };
  const server = createAppServer({ contractDrafts: reader, authenticate: async header => {
    if (!header || !/^Bearer (owner|planner|outsider)$/.test(header)) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    return header.slice(7);
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run("http://127.0.0.1:" + (server.address() as AddressInfo).port + "/events", calls); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const get = (url: string, user = "owner") => fetch(url, { headers: { authorization: "Bearer " + user } });

test("contract GET routes list saved drafts and open exact IDs using the verified subject", async () => {
  await withServer(async (base, calls) => {
    const list = await get(base + "/12/contract-drafts?limit=5&offset=0&status=DRAFT", "planner");
    assert.equal(list.status, 200); assert.equal(list.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await list.json(), { data: [draft], total: 1, limit: 5, offset: 0 });
    assert.deepEqual(calls[0], ["list", "12", "planner", { limit: 5, offset: 0, status: "DRAFT" }]);
    const detail = await get(base + "/12/contract-drafts/" + draft.draftId);
    assert.equal(detail.status, 200); assert.deepEqual(await detail.json(), { data: draft });
    assert.deepEqual(calls[1], ["get", "12", draft.draftId, "owner"]);
  });
});

test("contract GET routes deny unverified requests and preserve membership/404 behavior", async () => {
  await withServer(async (base, calls) => {
    const collection = base + "/12/contract-drafts";
    for (const url of [collection, collection + "/" + draft.draftId]) {
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await get(url, "forged")).status, 401);
    }
    assert.equal(calls.length, 0);
    assert.equal((await get(collection, "outsider")).status, 403);
    assert.equal((await get(collection + "/" + draft.draftId, "outsider")).status, 403);
    assert.equal((await get(base + "/13/contract-drafts")).status, 403);
    assert.equal((await get(collection + "/999")).status, 404);
  });
});

test("contract GET routes reject invalid IDs, repeated filters and unsupported operations", async () => {
  await withServer(async (base, calls) => {
    for (const path of ["/0/contract-drafts", "/12/contract-drafts/01", "/12/contract-drafts/18446744073709551616"]) {
      assert.equal((await get(base + path)).status, 400);
    }
    for (const query of ["limit=1&limit=2", "status=ready", "eventId=13"]) {
      assert.equal((await get(base + "/12/contract-drafts?" + query)).status, 422);
    }
    assert.equal((await get(base + "/12/contract-drafts/" + draft.draftId + "?status=DRAFT")).status, 422);
    const options = await fetch(base + "/12/contract-drafts", { method: "OPTIONS" });
    assert.equal(options.status, 204); assert.equal(await options.text(), "");
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await fetch(base + "/12/contract-drafts", { method, headers: { authorization: "Bearer owner" } });
      assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "GET, OPTIONS");
    }
    assert.equal((await get(base + "/12/contract-drafts/1/extra")).status, 404);
    assert.equal(calls.length, 0);
  });
});

test("contract GET routes return safe failures without logging SQL or document details", async t => {
  const logged = t.mock.method(console, "error", () => {});
  await withServer(async base => {
    const response = await get(base + "/12/contract-drafts");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Unable to load contract drafts." } });
    assert.ok(!JSON.stringify(logged.mock.calls).includes("private.sql"));
  }, new Error("private.sql: contract and credential details"));
});
