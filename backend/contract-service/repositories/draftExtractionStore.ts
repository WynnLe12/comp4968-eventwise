import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { getDatabasePool } from "../../shared/db/pool";
import type { Draft } from "../types";
import type { DraftExtractionSnapshot, DraftExtractionStore, DraftExtractionResult } from "../extraction/draftExtractionService";
import type { VerifiedTextDocument } from "../extraction/documentTextReader";
import type { ContractFieldSuggestions } from "../extraction/contractFieldSuggestions";
import { draftExtractionPatch } from "../extraction/draftExtractionPatch";
import { selectDraft } from "./draftReader";
import { withContractEvent } from "./eventTransaction";

const changed = () => new ApiError(409, "DRAFT_CHANGED", "This draft changed during extraction. Reload it before trying again.");
const documentChanged = () => new ApiError(409, "DOCUMENT_CHANGED", "The source document changed. Reopen the document before extracting again.");
function editable(draft: Draft, version: string) {
  if (draft.status !== "DRAFT") throw new ApiError(409, "DRAFT_NOT_EDITABLE", "Only a draft awaiting review can be extracted.");
  if (draft.version !== version) throw changed();
  if (draft.version === "18446744073709551615") throw new ApiError(409, "DRAFT_VERSION_LIMIT", "This draft cannot be changed further.");
}
const columns = { vendorName: "vendor_name", totalAmount: "total_amount", depositAmount: "deposit_amount", dueDate: "due_date" } as const;

export class MySqlDraftExtractionStore implements DraftExtractionStore {
  constructor(private readonly connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection()) {}

  private async draft(connection: PoolConnection, eventId: string, draftId: string, lock = false): Promise<Draft> {
    if (lock) await connection.execute("SELECT draft_id FROM draft_budget_items WHERE event_id = ? AND draft_id = ? FOR UPDATE", [eventId, draftId]);
    const [rows] = await connection.execute<(RowDataPacket & Draft)[]>(selectDraft +
      " WHERE d.event_id = ? AND d.draft_id = ? LIMIT 1", [eventId, draftId]);
    if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "Contract draft not found.");
    return rows[0];
  }
  private async document(connection: PoolConnection, eventId: string, documentId: string | null): Promise<VerifiedTextDocument> {
    if (!documentId) throw documentChanged();
    const [rows] = await connection.execute<(RowDataPacket & VerifiedTextDocument)[]>(
      "SELECT CAST(event_id AS CHAR) AS eventId, CAST(document_id AS CHAR) AS documentId, s3_object_key AS s3ObjectKey, content_type AS contentType, CAST(size_bytes AS CHAR) AS sizeBytes, content_sha256 AS contentSha256 FROM event_documents WHERE event_id = ? AND document_id = ? FOR SHARE", [eventId, documentId]);
    const doc = rows[0];
    if (!doc) throw documentChanged();
    if (doc.contentType !== "application/pdf") throw new ApiError(422, "PDF_REQUIRED", "Automatic text reading supports PDFs only. Enter image details manually.");
    if (!doc.contentSha256 || !/^[0-9a-f]{64}$/.test(doc.contentSha256)) throw new ApiError(409, "DOCUMENT_UNVERIFIED", "Create or reopen the draft before extracting details.");
    return doc;
  }
  private async checkDraftSource(connection: PoolConnection, draft: Draft, document: VerifiedTextDocument) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT content_sha256 FROM draft_budget_items WHERE event_id = ? AND draft_id = ? AND version = ? AND document_id = ?", [draft.eventId, draft.draftId, draft.version, document.documentId]);
    if (!rows[0]) throw changed();
    if (rows[0].content_sha256 !== document.contentSha256) throw documentChanged();
  }
  snapshot(eventId: string, draftId: string, sub: string, version: string): Promise<DraftExtractionSnapshot> {
    return withContractEvent(this.connect, eventId, sub, false, async connection => {
      const draft = await this.draft(connection, eventId, draftId);
      editable(draft, version);
      const document = await this.document(connection, eventId, draft.documentId);
      await this.checkDraftSource(connection, draft, document);
      return { draft, document };
    });
  }
  apply(snapshot: DraftExtractionSnapshot, sub: string, suggestions: ContractFieldSuggestions): Promise<DraftExtractionResult> {
    const { eventId, draftId, version } = snapshot.draft;
    return withContractEvent(this.connect, eventId, sub, false, async connection => {
      // Lock the source document before its referencing draft, matching document deletion.
      const document = await this.document(connection, eventId, snapshot.document.documentId);
      for (const field of ["s3ObjectKey", "contentType", "sizeBytes", "contentSha256"] as const) {
        if (document[field] !== snapshot.document[field]) throw documentChanged();
      }
      const current = await this.draft(connection, eventId, draftId, true);
      editable(current, version);
      if (current.documentId !== snapshot.document.documentId) throw documentChanged();
      await this.checkDraftSource(connection, current, document);
      const fill = draftExtractionPatch(current, suggestions);
      const metadata = JSON.stringify({ ...suggestions, appliedFields: fill.appliedFields, skippedFields: fill.skippedFields, warnings: fill.warnings });
      const fields = fill.appliedFields;
      const values = fields.map(field => {
        const value = fill.changes[field];
        if (value === undefined || value === null) throw new Error("Missing extraction value.");
        return value;
      });
      const [result] = await connection.execute<ResultSetHeader>(
        "UPDATE draft_budget_items SET " + fields.map(field => columns[field] + " = ?, ").join("") +
        "extracted_json = ?, updated_by_sub = ?, version = version + 1 WHERE event_id = ? AND draft_id = ? AND version = ? AND status = 'DRAFT'",
        [...values, metadata, sub, eventId, draftId, version]);
      if (result.affectedRows !== 1) throw changed();
      return { draft: await this.draft(connection, eventId, draftId), appliedFields: fields, skippedFields: fill.skippedFields, warnings: fill.warnings };
    });
  }
}
