import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import { getDatabasePool } from "../../shared/db/pool";
import type { DraftCreation, DraftCreator } from "../types";
import { createDocumentFingerprint, type DocumentFingerprint, type DraftDocument } from "../services/documentFingerprint";

import { withContractEvent } from "./eventTransaction";

interface Claim extends RowDataPacket { draftId: string; contentSha256: string | null }
const changed = () => new ApiError(409, "DOCUMENT_CHANGED", "The document changed. Please reopen it and try again.");

export class MySqlDraftCreator implements DraftCreator {
  constructor(
    private readonly connect: () => Promise<PoolConnection> = () => getDatabasePool().getConnection(),
    private readonly fingerprint: DocumentFingerprint = createDocumentFingerprint(),
  ) {}

  private async authorized<T>(eventId: string, sub: string, exclusive: boolean,
    work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    return withContractEvent(this.connect, eventId, sub, exclusive, work);
  }

  private async document(connection: PoolConnection, eventId: string, documentId: string, exclusive: boolean) {
    const [rows] = await connection.execute<(RowDataPacket & DraftDocument)[]>(`
      SELECT CAST(document_id AS CHAR) AS documentId, s3_object_key AS s3ObjectKey,
        content_type AS contentType, CAST(size_bytes AS CHAR) AS sizeBytes, content_sha256 AS contentSha256
      FROM event_documents WHERE event_id = ? AND document_id = ?
    ` + (exclusive ? "FOR UPDATE" : "FOR SHARE"), [eventId, documentId]);
    const doc = rows[0];
    if (!doc) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    const prefix = "events/" + eventId + "/documents/";
    const size = Number(doc.sizeBytes);
    if (!["application/pdf", "image/jpeg", "image/png"].includes(doc.contentType) ||
        !Number.isSafeInteger(size) || size < 1 || size > 10 * 1024 * 1024 ||
        !doc.s3ObjectKey.startsWith(prefix) || !/^[0-9a-f-]{36}$/.test(doc.s3ObjectKey.slice(prefix.length))) {
      throw new ApiError(422, "INVALID_DOCUMENT", "Choose a completed PDF, JPG or PNG upload up to 10 MB.");
    }
    return doc;
  }

  async create(eventId: string, documentId: string, sub: string): Promise<DraftCreation> {
    parseId(eventId, "eventId", true); parseId(documentId, "documentId");
    if (typeof sub !== "string" || !sub || sub.trim() !== sub || sub.length > 128) {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    const before = await this.authorized(eventId, sub, false,
      connection => this.document(connection, eventId, documentId, false));
    // No DB locks are held while fetching older S3 files.
    const hash = before.contentSha256 ?? await this.fingerprint(before);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(500, "INTERNAL_ERROR", "Unable to verify the contract.");
    return this.authorized(eventId, sub, true, async connection => {
      const current = await this.document(connection, eventId, documentId, true);
      if (current.s3ObjectKey !== before.s3ObjectKey || current.contentType !== before.contentType ||
          current.sizeBytes !== before.sizeBytes || (current.contentSha256 !== null && current.contentSha256 !== hash)) throw changed();
      const [byDocument] = await connection.execute<Claim[]>(`
        SELECT CAST(draft_id AS CHAR) AS draftId, content_sha256 AS contentSha256
        FROM draft_budget_items WHERE event_id = ? AND document_id = ? FOR UPDATE
      `, [eventId, documentId]);
      const [byHash] = await connection.execute<Claim[]>(`
        SELECT CAST(draft_id AS CHAR) AS draftId, content_sha256 AS contentSha256
        FROM draft_budget_items WHERE event_id = ? AND content_sha256 = ? FOR UPDATE
      `, [eventId, hash]);
      const existing = byDocument[0], matching = byHash[0];
      if (existing && matching && existing.draftId !== matching.draftId) {
        // Never merge or discard legacy drafts, especially confirmed financial history.
        throw new ApiError(409, "DUPLICATE_CONTRACT", "This file has conflicting saved drafts. Review the existing drafts first.");
      }
      if (existing?.contentSha256 && existing.contentSha256 !== hash) throw changed();
      if (current.contentSha256 === null) {
        await connection.execute("UPDATE event_documents SET content_sha256 = ? WHERE event_id = ? AND document_id = ?",
          [hash, eventId, documentId]);
      }
      if (existing) {
        if (existing.contentSha256 === null) {
          await connection.execute("UPDATE draft_budget_items SET content_sha256 = ? WHERE event_id = ? AND draft_id = ?",
            [hash, eventId, existing.draftId]);
        }
        return { draftId: existing.draftId, created: false };
      }
      if (matching) return { draftId: matching.draftId, created: false };
      // The event lock serializes simultaneous creates; unique document/hash keys are the final guard.
      const [result] = await connection.execute<ResultSetHeader>(`
        INSERT INTO draft_budget_items (event_id, document_id, content_sha256, created_by_sub, updated_by_sub)
        VALUES (?, ?, ?, ?, ?)
      `, [eventId, documentId, hash, sub, sub]);
      return { draftId: String(result.insertId), created: true };
    });
  }
}
