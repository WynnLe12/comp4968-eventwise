import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { db } from "../../shared/db/db";

export interface DocumentRecord extends RowDataPacket {
    document_id: string;
    event_id: string;
    uploaded_by_sub: string;
    s3_object_key: string;
    original_filename: string;
    content_type: string;
    size_bytes: string;
    created_at: Date;
}

export interface CreateDocumentInput {
    eventId: string;
    uploadedBySub: string;
    s3ObjectKey: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: number;
}

export class DocumentRepository {
    // Check whether the user belongs to the selected event.
    async getMemberRole(
        eventId: string,
        cognitoSub: string,
    ): Promise<"OWNER" | "CO_PLANNER" | null> {
        const [rows] = await db.execute<
            (RowDataPacket & { role: "OWNER" | "CO_PLANNER" })[]
        >(
            `SELECT role
            FROM event_members
            WHERE event_id = ? AND cognito_sub = ?
            LIMIT 1`,
            [eventId, cognitoSub],
        );

        return rows[0]?.role ?? null;
    }

    // Retrieve all documents for one event.
    async listByEvent(eventId: string): Promise<DocumentRecord[]> {
        const [rows] = await db.execute<DocumentRecord[]>(
            `SELECT document_id, event_id, uploaded_by_sub,
              s3_object_key, original_filename,
              content_type, size_bytes, created_at
            FROM event_documents
            WHERE event_id = ?
            ORDER BY created_at DESC, document_id DESC`,
            [eventId],
        );

        return rows;
    }

    // Retrieve one document belonging to an event.
    async getById(
        eventId: string,
        documentId: string,
    ): Promise<DocumentRecord | null> {
        const [rows] = await db.execute<DocumentRecord[]>(
            `SELECT document_id, event_id, uploaded_by_sub,
              s3_object_key, original_filename,
              content_type, size_bytes, created_at
            FROM event_documents
            WHERE event_id = ? AND document_id = ?
            LIMIT 1`,
            [eventId, documentId],
        );

        return rows[0] ?? null;
    }

    // Register an uploaded document only once.
    // Repeated completion requests return the existing ID.
    async create(input: CreateDocumentInput): Promise<string> {
        const [result] = await db.execute<ResultSetHeader>(
            `INSERT INTO event_documents
            (event_id, uploaded_by_sub, s3_object_key,
                original_filename, content_type, size_bytes)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                document_id = LAST_INSERT_ID(document_id)`,
            [
                input.eventId,
                input.uploadedBySub,
                input.s3ObjectKey,
                input.originalFilename,
                input.contentType,
                input.sizeBytes,
            ],
        );

        return String(result.insertId);
    }

    // Check whether F15 has created any budget drafts
    // using this document.
    async isUsedByBudgetDraft(
        eventId: string,
        documentId: string,
    ): Promise<boolean> {
        const [rows] = await db.execute<
            (RowDataPacket & { draft_id: string })[]
        >(
            `SELECT draft_id
            FROM draft_budget_items
            WHERE event_id = ? AND document_id = ?
            LIMIT 1`,
            [eventId, documentId],
        );

        return rows.length > 0;
    }

    // Delete the document metadata only if it still belongs
    // to the selected event and has no F15 references.
    async deleteById(
        eventId: string,
        documentId: string,
    ): Promise<boolean> {
        const [result] = await db.execute<ResultSetHeader>(
            `DELETE FROM event_documents
            WHERE event_id = ?
                AND document_id = ?
                AND NOT EXISTS (
                SELECT 1
                FROM draft_budget_items
                WHERE draft_budget_items.document_id = ?
                )`,
            [eventId, documentId, documentId],
        );

        return result.affectedRows > 0;
    }

    // Find an already registered document by its S3 key.
    // Used to handle repeated upload completion requests.
    async getByS3Key(
        eventId: string,
        s3ObjectKey: string,
    ): Promise<DocumentRecord | null> {
        const [rows] = await db.execute<DocumentRecord[]>(
            `SELECT document_id, event_id, uploaded_by_sub,
              s3_object_key, original_filename,
              content_type, size_bytes, created_at
            FROM event_documents
            WHERE event_id = ?
                AND s3_object_key = ?
            LIMIT 1`,
            [eventId, s3ObjectKey],
        );

        return rows[0] ?? null;
    }
}
