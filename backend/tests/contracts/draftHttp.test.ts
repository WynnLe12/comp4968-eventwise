import "../testEnvironment";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { ApiError } from "../../expense-service/errors";
import type { Draft, DraftCreator, DraftDiscarder, DraftReader, DraftUpdater } from "../../contract-service/types";
import { createAppServer } from "../../server";
import { parseDraftPatch, parseDraftVersion } from "../../contract-service/services/draftValidation";

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
  let saved = structuredClone(draft);
  function authorize(eventId: string, sub: string) {
    if (failure) throw failure;
    if (eventId !== "12" || !["owner", "planner"].includes(sub)) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
  }
  const reader: DraftReader = {
    async list(eventId, sub, query) {
      calls.push(["list", eventId, sub, query]); authorize(eventId, sub);
      return { data: [saved], total: 1, limit: query.limit, offset: query.offset };
    },
    async get(eventId, id, sub) {
      calls.push(["get", eventId, id, sub]); authorize(eventId, sub);
      return id === draft.draftId ? saved : null;
    },
  };
  let created = false;
  const creator: DraftCreator = {
    async create(eventId, documentId, sub) {
      calls.push(["create", eventId, documentId, sub]); authorize(eventId, sub);
      if (documentId !== "23") throw new ApiError(404, "NOT_FOUND", "Document not found.");
      const result = { draftId: draft.draftId, created: !created };
      created = true; return result;
    },
  };
  const updater: DraftUpdater = {
    async update(eventId, draftId, sub, body) {
      calls.push(["update", eventId, draftId, sub, body]); authorize(eventId, sub);
      if (draftId !== saved.draftId) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
      const input = parseDraftPatch(body);
      if (saved.status !== "DRAFT") throw new ApiError(409, "DRAFT_NOT_EDITABLE", "Only an open draft can be edited.");
      if (input.version !== saved.version) throw new ApiError(409, "DRAFT_CHANGED", "Reload this draft.");
      saved = { ...saved, ...input.changes, version: String(BigInt(saved.version) + 1n) };
      return saved;
    },
  };
  const discarder: DraftDiscarder = {
    async discard(eventId, draftId, sub, body) {
      calls.push(["discard", eventId, draftId, sub, body]); authorize(eventId, sub);
      if (draftId !== saved.draftId) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
      const { version } = parseDraftVersion(body);
      if (saved.status !== "REJECTED") {
        if (version !== saved.version) throw new ApiError(409, "DRAFT_CHANGED", "Reload this draft.");
        saved = { ...saved, status: "REJECTED", version: String(BigInt(saved.version) + 1n) };
      }
      return saved;
    },
  };
  const server = createAppServer({ contractDrafts: reader, contractDraftCreator: creator, contractDraftUpdater: updater,
    contractDraftDiscarder: discarder, authenticate: async header => {
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
    for (const method of ["PATCH", "DELETE"]) {
      const response = await fetch(base + "/12/contract-drafts", { method, headers: { authorization: "Bearer owner" } });
      assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "GET, POST, OPTIONS");
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

const post = (url: string, body: unknown, user = "owner") => fetch(url, {
  method: "POST", headers: { authorization: "Bearer " + user, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("contract POST creates once, returns existing drafts on retry, and links to the GET endpoint", async () => {
  await withServer(async (base, calls) => {
    const url = base + "/12/contract-drafts";
    const first = await post(url, { documentId: "23" }, "planner");
    assert.equal(first.status, 201); assert.equal(first.headers.get("Cache-Control"), "no-store");
    const location = "/events/12/contract-drafts/" + draft.draftId;
    assert.equal(first.headers.get("Location"), location);
    assert.deepEqual(await first.json(), { data: { draftId: draft.draftId }, created: true });
    assert.deepEqual(calls[0], ["create", "12", "23", "planner"]);
    const repeat = await post(url, { documentId: "23" });
    assert.equal(repeat.status, 200); assert.equal(repeat.headers.get("Location"), location);
    assert.deepEqual(await repeat.json(), { data: { draftId: draft.draftId }, created: false });
    const detail = await get(new URL(location, base).toString());
    assert.equal(detail.status, 200); assert.deepEqual(await detail.json(), { data: draft });
  });
});

test("contract POST rejects invalid JSON, oversized bodies, forged fields and query overrides before creation", async () => {
  await withServer(async (base, calls) => {
    const url = base + "/12/contract-drafts";
    const headers = { authorization: "Bearer owner", "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer owner" }, body: "{}" })).status, 415);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ documentId: "23", padding: "x".repeat(65536) }) })).status, 413);
    for (const body of [{}, [], { documentId: 23 }, { documentId: "01" },
      { documentId: "23", sub: "owner" }, { documentId: "23", eventId: "13" },
      { documentId: "23", contentSha256: "a".repeat(64) }, { documentId: "23", totalAmount: "500.00" }]) {
      assert.equal((await post(url, body)).status, 422);
    }
    assert.equal((await post(url + "?eventId=13", { documentId: "23" })).status, 422);
    const item = await post(url + "/" + draft.draftId, { documentId: "23" });
    assert.equal(item.status, 405); assert.equal(item.headers.get("Allow"), "GET, PATCH, OPTIONS");
    assert.equal(calls.length, 0);
  });
});

test("contract POST requires verified identity and preserves event/document access errors", async () => {
  await withServer(async (base, calls) => {
    const url = base + "/12/contract-drafts";
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"documentId":"23"}' })).status, 401);
    assert.equal((await post(url, { documentId: "23" }, "forged")).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await post(url, { documentId: "23" }, "outsider")).status, 403);
    assert.equal((await post(base + "/13/contract-drafts", { documentId: "23" })).status, 403);
    assert.equal((await post(url, { documentId: "24" })).status, 404);
  });
  for (const failure of [
    new ApiError(409, "DOCUMENT_CHANGED", "Please reopen this document."),
    new ApiError(422, "INVALID_DOCUMENT", "Choose a supported contract."),
    new ApiError(503, "DOCUMENT_UNAVAILABLE", "Please try again."),
  ]) {
    await withServer(async base => {
      const response = await post(base + "/12/contract-drafts", { documentId: "23" });
      assert.equal(response.status, failure.status);
      assert.equal((await response.json()).error.code, failure.code);
    }, failure);
  }
});

test("contract POST returns a safe failure when creation fails unexpectedly", async t => {
  const logged = t.mock.method(console, "error", () => {});
  await withServer(async base => {
    const response = await post(base + "/12/contract-drafts", { documentId: "23" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Unable to create the contract draft." } });
    assert.ok(!JSON.stringify(logged.mock.calls).includes("private.sql"));
  }, new Error("private.sql: document and credential details"));
});

const patch = (url: string, body: unknown, user = "owner") => fetch(url, {
  method: "PATCH", headers: { authorization: "Bearer " + user, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("contract PATCH saves draft fields with the verified identity and returns the new version", async () => {
  await withServer(async (base, calls) => {
    const url = base + "/12/contract-drafts/" + draft.draftId;
    const body = { version: "1", description: "  Reviewed contract  ", totalAmount: "5500.10" };
    const response = await patch(url, body, "planner");
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
    const updated = (await response.json()).data;
    assert.equal(updated.description, "Reviewed contract"); assert.equal(updated.totalAmount, "5500.10");
    assert.equal(updated.version, "2"); assert.equal(updated.status, "DRAFT");
    assert.deepEqual(calls[0], ["update", "12", draft.draftId, "planner", body]);
    assert.deepEqual((await (await get(url)).json()).data, updated);
    const stale = await patch(url, { version: "1", description: "Stale edit" });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, "DRAFT_CHANGED");
    assert.equal((await (await get(url)).json()).data.description, "Reviewed contract");
  });
});

test("contract PATCH rejects malformed requests, readonly fields and query overrides", async () => {
  await withServer(async (base, calls) => {
    const url = base + "/12/contract-drafts/" + draft.draftId;
    const headers = { authorization: "Bearer owner", "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "PATCH", headers, body: "{" })).status, 400);
    assert.equal((await fetch(url, { method: "PATCH", headers: { authorization: "Bearer owner" }, body: "{}" })).status, 415);
    assert.equal((await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ version: "1", description: "x".repeat(65536) }) })).status, 413);
    assert.equal((await patch(url + "?eventId=13", { version: "1", description: "Edit" })).status, 422);
    assert.equal(calls.length, 0);
    for (const body of [{ description: "Edit" }, { version: 1, description: "Edit" },
      { version: "1", status: "CONFIRMED" }, { version: "1", contentSha256: "a".repeat(64) }]) {
      assert.equal((await patch(url, body)).status, 422);
    }
    assert.equal((await patch(base + "/12/contract-drafts", { version: "1", description: "Edit" })).status, 405);
  });
});

test("contract PATCH requires authentication, respects event access, and preserves edit conflicts", async () => {
  await withServer(async base => {
    const url = base + "/12/contract-drafts/" + draft.draftId;
    const body = { version: "1", description: "Edit" };
    assert.equal((await fetch(url, { method: "PATCH" })).status, 401);
    assert.equal((await patch(url, body, "forged")).status, 401);
    assert.equal((await patch(url, body, "outsider")).status, 403);
    assert.equal((await patch(base + "/13/contract-drafts/" + draft.draftId, body)).status, 403);
    assert.equal((await patch(base + "/12/contract-drafts/999", body)).status, 404);
  });
  await withServer(async base => {
    const response = await patch(base + "/12/contract-drafts/" + draft.draftId, { version: "1", description: "Edit" });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "DRAFT_NOT_EDITABLE");
  }, new ApiError(409, "DRAFT_NOT_EDITABLE", "Only an open draft can be edited."));
});

test("contract PATCH never exposes private errors when saving fails", async t => {
  const logged = t.mock.method(console, "error", () => {});
  await withServer(async base => {
    const response = await patch(base + "/12/contract-drafts/" + draft.draftId, { version: "1", description: "Edit" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Unable to save the contract draft." } });
    assert.ok(!JSON.stringify(logged.mock.calls).includes("private.sql"));
  }, new Error("private.sql: document and credential details"));
});

test("contract discard keeps the document link, returns the saved draft and supports repeated clicks", async () => {
  await withServer(async (base, calls) => {
    const item = base + "/12/contract-drafts/" + draft.draftId;
    const response = await post(item + "/discard", { version: "1" }, "planner");
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
    const rejected = { ...draft, status: "REJECTED", version: "2" };
    assert.deepEqual(await response.json(), { data: rejected });
    assert.deepEqual(calls[0], ["discard", "12", draft.draftId, "planner", { version: "1" }]);
    assert.deepEqual(await (await get(item)).json(), { data: rejected });
    const retry = await post(item + "/discard", { version: "1" });
    assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { data: rejected });
    assert.equal((await patch(item, { version: "2", description: "Late edit" })).status, 409);
  });
});

test("contract discard checks identity, event membership, missing IDs and stale versions", async () => {
  await withServer(async (base, calls) => {
    const item = base + "/12/contract-drafts/" + draft.draftId;
    const url = item + "/discard";
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await post(url, { version: "1" }, "forged")).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await post(url, { version: "1" }, "outsider")).status, 403);
    assert.equal((await post(base + "/13/contract-drafts/" + draft.draftId + "/discard", { version: "1" })).status, 403);
    assert.equal((await post(base + "/12/contract-drafts/999/discard", { version: "1" })).status, 404);
    await patch(item, { version: "1", description: "Newer edit" });
    const stale = await post(url, { version: "1" });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, "DRAFT_CHANGED");
    assert.equal((await (await get(item)).json()).data.status, "DRAFT");
    const latest = await post(url, { version: "2" });
    assert.equal(latest.status, 200); assert.equal((await latest.json()).data.version, "3");
  });
});

test("contract discard accepts only versioned JSON POST requests and unauthenticated preflight", async () => {
  await withServer(async (base, calls) => {
    const item = base + "/12/contract-drafts/" + draft.draftId;
    const url = item + "/discard";
    const headers = { authorization: "Bearer owner", "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer owner" }, body: "{}" })).status, 415);
    assert.equal((await post(url, { version: "1", padding: "x".repeat(65536) })).status, 413);
    assert.equal((await post(url + "?eventId=13", { version: "1" })).status, 422);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await fetch(url, { method, headers: { authorization: "Bearer owner" } });
      assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
    }
    const options = await fetch(url, { method: "OPTIONS" });
    assert.equal(options.status, 204); assert.equal(options.headers.get("Allow"), "POST, OPTIONS");
    assert.equal(await options.text(), "");
    assert.equal((await fetch(item, { method: "DELETE", headers: { authorization: "Bearer owner" } })).status, 405);
    assert.equal(calls.length, 0);
    for (const body of [{}, [], { version: 1 }, { version: "1", status: "REJECTED" }, { version: "1", documentId: "99" }]) {
      assert.equal((await post(url, body)).status, 422);
    }
    assert.equal((await (await get(item)).json()).data.status, "DRAFT");
  });
});

test("contract discard preserves confirmed-state errors and hides unexpected storage failures", async t => {
  await withServer(async base => {
    const response = await post(base + "/12/contract-drafts/" + draft.draftId + "/discard", { version: "1" });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "DRAFT_NOT_EDITABLE");
  }, new ApiError(409, "DRAFT_NOT_EDITABLE", "A confirmed draft cannot be discarded."));
  const logged = t.mock.method(console, "error", () => {});
  await withServer(async base => {
    const response = await post(base + "/12/contract-drafts/" + draft.draftId + "/discard", { version: "1" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "Unable to discard the contract draft." } });
    assert.ok(!JSON.stringify(logged.mock.calls).includes("private.sql"));
  }, new Error("private.sql: document and credential details"));
});
