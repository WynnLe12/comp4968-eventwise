import { MySqlDraftConfirmer } from "../../contract-service/repositories/draftConfirmer";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { getDatabasePool, closeDatabasePool } from "../../shared/db/pool";
import { MySqlDraftExtractionStore } from "../../contract-service/repositories/draftExtractionStore";
import { MySqlDraftReader } from "../../contract-service/repositories/draftReader";
import { MySqlDraftUpdater } from "../../contract-service/repositories/draftUpdater";
import { MySqlDraftDiscarder } from "../../contract-service/repositories/draftDiscarder";
import { DraftExtractionService } from "../../contract-service/extraction/draftExtractionService";
import { PdfTextError, type PdfTextResult } from "../../contract-service/extraction/pdfTextTypes";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1", timeout: 10000 };
const store = new MySqlDraftExtractionStore(), updater = new MySqlDraftUpdater(), reader = new MySqlDraftReader();
const body = "Vendor: Example DJ\nTotal: 630.00\nDeposit required: 100.00\nDue date: Dec 10, 2026";
const text: PdfTextResult = { pageCount: 1, text: body, pages: [{ pageNumber: 1, text: body }], emptyPageNumbers: [] };
const extract = (read: () => Promise<PdfTextResult> = async () => text) => new DraftExtractionService(store, read);
after(closeDatabasePool);
async function insert(sql: string, values: (string | number | null)[] = []) {
  const [result] = await getDatabasePool().execute<ResultSetHeader>(sql, values); return String(result.insertId);
}
interface Fixture { event: string; otherEvent: string; owner: string; planner: string; document: string; draft: string; category: string; vendor: string }
async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const events: string[] = [], owner = "owner-" + randomUUID(), planner = "planner-" + randomUUID();
  try {
    for (const name of ["A", "B"]) events.push(await insert("INSERT INTO events (name) VALUES (?)", ["Extraction " + name]));
    const [event, otherEvent] = events;
    await insert("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'OWNER')", [event, owner, event, planner, otherEvent, owner]);
    const category = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, 'Entertainment')", [event]);
    const vendor = await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Reviewed vendor')", [event]);
    const expense = await insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, 'Existing expense', '1000.00')", [event, category, vendor]);
    await insert("INSERT INTO expense_payments (expense_id, amount, paid_at) VALUES (?, '50.00', '2026-11-26')", [expense]);
    const document = await insert("INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes, content_sha256) VALUES (?, ?, ?, 'invoice.pdf', 'application/pdf', 100, ?)", [event, owner, "events/" + event + "/documents/" + randomUUID(), "a".repeat(64)]);
    const draft = await insert("INSERT INTO draft_budget_items (event_id, document_id, content_sha256) VALUES (?, ?, ?)", [event, document, "a".repeat(64)]);
    await run({ event, otherEvent, owner, planner, document, draft, category, vendor });
  } finally {
    for (const event of events) {
      await getDatabasePool().execute("DELETE FROM draft_budget_items WHERE event_id = ?", [event]);
      await getDatabasePool().execute("DELETE p FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id WHERE e.event_id = ?", [event]);
      await getDatabasePool().execute("DELETE FROM expenses WHERE event_id = ?", [event]);
      await getDatabasePool().execute("DELETE FROM events WHERE event_id = ?", [event]);
    }
  }
}
async function finances() { return Promise.all(["vendors", "expenses", "expense_payments"].map(async table => (await getDatabasePool().query<RowDataPacket[]>("SELECT * FROM " + table))[0].map(row => ({ ...row })))); }
const code = (value: string) => (error: unknown) => error instanceof ApiError && error.code === value;

test("MySQL extraction fills blank draft fields, persists provenance and audit/version, and leaves financial records unchanged", integration, async () => {
  await fixture(async f => {
    const before = await finances();
    const result = await extract().extract(f.event, f.draft, f.planner, { version: "1" });
    assert.equal(result.draft.vendorName, "Example DJ"); assert.equal(result.draft.totalAmount, "630.00");
    assert.equal(result.draft.depositAmount, "100.00"); assert.equal(result.draft.dueDate, "2026-12-10");
    assert.equal(result.draft.version, "2"); assert.equal(result.draft.status, "DRAFT");
    assert.equal(result.draft.description, null); assert.equal(result.draft.vendorId, null); assert.equal(result.draft.categoryId, null);
    assert.equal(result.draft.confirmedExpenseId, null); assert.equal(result.draft.currencyCode, null);
    assert.deepEqual(await reader.get(f.event, f.draft, f.owner), result.draft);
    const [[audit]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT updated_by_sub, extracted_json FROM draft_budget_items WHERE draft_id = ?", [f.draft]);
    assert.equal(audit.updated_by_sub, f.planner);
    const metadata = typeof audit.extracted_json === "string" ? JSON.parse(audit.extracted_json) : audit.extracted_json;
    assert.equal(metadata.reviewRequired, true); assert.equal(metadata.provider, "pdf-labels-v1"); assert.equal(metadata.appliedFields.length, 4);
    assert.deepEqual(await finances(), before);
  });
});

test("MySQL extraction preserves reviewed fields, selected category/vendor, and optional currency metadata", integration, async () => {
  await fixture(async f => {
    const saved = await updater.update(f.event, f.draft, f.owner, { version: "1", description: "Manual review", categoryId: f.category, vendorId: f.vendor,
      vendorName: "Manual vendor", totalAmount: "900.00", depositAmount: "200.00", dueDate: "2027-01-15", currencyCode: "CAD" });
    const result = await extract().extract(f.event, f.draft, f.planner, { version: "2" });
    assert.deepEqual(result.appliedFields, []); assert.equal(result.skippedFields.length, 4);
    for (const field of ["description", "categoryId", "vendorId", "vendorName", "totalAmount", "depositAmount", "dueDate", "currencyCode"] as const) assert.equal(result.draft[field], saved[field]);
    assert.equal(result.draft.version, "3");
  });
});

test("MySQL extraction releases its initial transaction during file reading and never overwrites an edit made then", integration, async () => {
  await fixture(async f => {
    const before = await finances();
    const service = extract(async () => { await updater.update(f.event, f.draft, f.owner, { version: "1", totalAmount: "800.00" }); return text; });
    await assert.rejects(service.extract(f.event, f.draft, f.planner, { version: "1" }), code("DRAFT_CHANGED"));
    const saved = await reader.get(f.event, f.draft, f.owner);
    assert.equal(saved!.totalAmount, "800.00"); assert.equal(saved!.vendorName, null); assert.equal(saved!.version, "2");
    assert.deepEqual(await finances(), before);
  });
});

test("MySQL concurrent extraction applications allow only one versioned save", integration, async () => {
  await fixture(async f => {
    const results = await Promise.allSettled([extract().extract(f.event, f.draft, f.owner, { version: "1" }), extract().extract(f.event, f.draft, f.planner, { version: "1" })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const failed = results.find(result => result.status === "rejected");
    assert.ok(failed?.status === "rejected" && failed.reason instanceof ApiError && failed.reason.code === "DRAFT_CHANGED");
    assert.equal((await reader.get(f.event, f.draft, f.owner))!.version, "2");
  });
});

test("MySQL event access, nested event IDs, stale versions and finalized drafts are checked before file reading", integration, async () => {
  await fixture(async f => {
    let reads = 0; const service = extract(async () => { reads++; return text; });
    await assert.rejects(service.extract(f.event, f.draft, "outsider", { version: "1" }), code("FORBIDDEN"));
    await assert.rejects(service.extract(f.otherEvent, f.draft, f.owner, { version: "1" }), code("NOT_FOUND"));
    await assert.rejects(service.extract(f.event, f.draft, f.owner, { version: "2" }), code("DRAFT_CHANGED"));
    await new MySqlDraftDiscarder().discard(f.event, f.draft, f.owner, { version: "1" });
    await assert.rejects(service.extract(f.event, f.draft, f.owner, { version: "2" }), code("DRAFT_NOT_EDITABLE"));
    assert.equal(reads, 0);
  });
});

test("MySQL extraction rechecks membership after reading the PDF", integration, async () => {
  await fixture(async f => {
    const service = extract(async () => { await getDatabasePool().execute("DELETE FROM event_members WHERE event_id = ? AND cognito_sub = ?", [f.event, f.owner]); return text; });
    await assert.rejects(service.extract(f.event, f.draft, f.owner, { version: "1" }), code("FORBIDDEN"));
    const saved = await reader.get(f.event, f.draft, f.planner);
    assert.equal(saved!.version, "1"); assert.equal(saved!.totalAmount, null);
  });
});

test("MySQL source changes and source deletion during extraction cannot apply stale suggestions", integration, async () => {
  for (const remove of [false, true]) await fixture(async f => {
    const service = extract(async () => {
      if (remove) await getDatabasePool().execute("DELETE FROM event_documents WHERE document_id = ?", [f.document]);
      else await getDatabasePool().execute("UPDATE event_documents SET content_sha256 = ? WHERE document_id = ?", ["b".repeat(64), f.document]);
      return text;
    });
    await assert.rejects(service.extract(f.event, f.draft, f.owner, { version: "1" }), code("DOCUMENT_CHANGED"));
    const saved = await reader.get(f.event, f.draft, f.owner);
    assert.equal(saved!.version, "1"); assert.equal(saved!.totalAmount, null);
  });
});

test("MySQL discarded drafts reject an in-flight extraction and parser failures leave the draft unchanged", integration, async () => {
  await fixture(async f => {
    const failed = extract(async () => { throw new PdfTextError("PDF_NO_TEXT"); });
    await assert.rejects(failed.extract(f.event, f.draft, f.owner, { version: "1" }), code("PDF_NO_TEXT"));
    assert.equal((await reader.get(f.event, f.draft, f.owner))!.version, "1");
    const discard = extract(async () => { await new MySqlDraftDiscarder().discard(f.event, f.draft, f.owner, { version: "1" }); return text; });
    await assert.rejects(discard.extract(f.event, f.draft, f.owner, { version: "1" }), code("DRAFT_NOT_EDITABLE"));
    const saved = await reader.get(f.event, f.draft, f.owner);
    assert.equal(saved!.status, "REJECTED"); assert.equal(saved!.totalAmount, null);
  });
});


test("MySQL extraction readback failures roll back suggested fields, version, provenance and audit", integration, async () => {
  await fixture(async f => {
    const before = await finances();
    const connect = async () => {
      const connection = await getDatabasePool().getConnection();
      let wrote = false;
      return new Proxy(connection, { get(target, property) {
        if (property === "execute") return async (sql: string, values?: unknown[]) => {
          if (wrote && sql.includes("LEFT JOIN event_documents")) throw new Error("Injected private readback failure");
          const result = await Reflect.apply(target.execute, target, [sql, values]);
          if (sql.startsWith("UPDATE draft_budget_items SET ")) wrote = true;
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const service = new DraftExtractionService(new MySqlDraftExtractionStore(connect), async () => text);
    await assert.rejects(service.extract(f.event, f.draft, f.owner, { version: "1" }), error => error instanceof ApiError && error.code === "EXTRACTION_FAILED" && !error.message.includes("private"));
    const saved = await reader.get(f.event, f.draft, f.owner);
    assert.equal(saved!.totalAmount, null); assert.equal(saved!.version, "1");
    const [[audit]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT updated_by_sub, extracted_json FROM draft_budget_items WHERE draft_id = ?", [f.draft]);
    assert.equal(audit.updated_by_sub, null); assert.equal(audit.extracted_json, null);
    assert.deepEqual(await finances(), before);
  });
});

test("MySQL extraction preserves large version precision and rejects version overflow before reading", integration, async () => {
  await fixture(async f => {
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = 9007199254740993 WHERE draft_id = ?", [f.draft]);
    let reads = 0;
    const service = extract(async () => { reads++; return text; });
    const result = await service.extract(f.event, f.draft, f.owner, { version: "9007199254740993" });
    assert.equal(result.draft.version, "9007199254740994");
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = 18446744073709551615 WHERE draft_id = ?", [f.draft]);
    await assert.rejects(service.extract(f.event, f.draft, f.owner, { version: "18446744073709551615" }), code("DRAFT_VERSION_LIMIT"));
    assert.equal(reads, 1);
  });
});

test("MySQL a confirmation completed during extraction stays final and its financial records are preserved", integration, async () => {
  await fixture(async f => {
    await updater.update(f.event, f.draft, f.owner, { version: "1", description: "Reviewed expense", categoryId: f.category, vendorId: f.vendor, totalAmount: "700.00" });
    let afterConfirmation: unknown;
    const service = extract(async () => {
      const confirmed = await new MySqlDraftConfirmer().confirm(f.event, f.draft, f.owner, { version: "2" });
      assert.equal(confirmed.draft.status, "CONFIRMED");
      afterConfirmation = await finances(); return text;
    });
    await assert.rejects(service.extract(f.event, f.draft, f.planner, { version: "2" }), code("DRAFT_NOT_EDITABLE"));
    const saved = await reader.get(f.event, f.draft, f.owner);
    assert.equal(saved!.status, "CONFIRMED"); assert.equal(saved!.totalAmount, "700.00"); assert.equal(saved!.depositAmount, null);
    assert.deepEqual(await finances(), afterConfirmation);
  });
});
