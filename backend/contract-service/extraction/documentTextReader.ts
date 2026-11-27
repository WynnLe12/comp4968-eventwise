import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import type { DraftDocument } from "../services/documentFingerprint";
import { extractPdfText, PDF_TEXT_LIMITS, PdfTextError, type PdfTextResult } from "./pdfText";

export interface VerifiedTextDocument extends DraftDocument { eventId: string }
export type DocumentTextResult = PdfTextResult & { eventId: string; documentId: string; contentSha256: string };

/** Internal API: the caller must authorize the event and load document metadata from the database. */
export function createDocumentTextReader(
  client = new S3Client({}), bucket = process.env.DOCUMENTS_BUCKET_NAME ?? "",
  parse: (bytes: Uint8Array) => Promise<PdfTextResult> = extractPdfText,
) {
  return async (document: VerifiedTextDocument): Promise<DocumentTextResult> => {
    parseId(document.eventId, "eventId"); parseId(document.documentId, "documentId");
    if (!bucket) throw new ApiError(503, "SERVICE_UNAVAILABLE", "Document storage is not configured.");
    if (document.contentType !== "application/pdf") throw new ApiError(422, "PDF_REQUIRED", "Automatic text reading supports PDFs only. Enter image details manually.");
    const expected = Number(document.sizeBytes);
    const prefix = "events/" + document.eventId + "/documents/";
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > PDF_TEXT_LIMITS.bytes ||
        !document.s3ObjectKey.startsWith(prefix) || !/^[0-9a-f-]{36}$/.test(document.s3ObjectKey.slice(prefix.length))) {
      throw new ApiError(422, "INVALID_DOCUMENT", "Choose a completed PDF upload up to 10 MB from this event.");
    }
    if (!document.contentSha256 || !/^[0-9a-f]{64}$/.test(document.contentSha256)) {
      throw new ApiError(409, "DOCUMENT_UNVERIFIED", "Create or reopen the contract draft before extracting text.");
    }
    let bytes: Buffer;
    const controller = new AbortController();
    let body: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const download = async () => {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: document.s3ObjectKey }), { abortSignal: controller.signal });
        body = object.Body && Symbol.asyncIterator in object.Body ? object.Body as NonNullable<typeof body> : undefined;
        if (object.ContentLength !== expected || object.ContentType !== document.contentType || !object.Body || !(Symbol.asyncIterator in object.Body)) {
          throw new ApiError(409, "DOCUMENT_CHANGED", "The stored file no longer matches this document.");
        }
        const chunks: Buffer[] = [];
        const digest = createHash("sha256");
        let received = 0;
        for await (const chunk of body!) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Invalid document stream.");
          received += chunk.byteLength;
          if (received > expected) throw new ApiError(409, "DOCUMENT_CHANGED", "The stored file size changed.");
          digest.update(chunk); chunks.push(Buffer.from(chunk));
        }
        if (received !== expected || digest.digest("hex") !== document.contentSha256) throw new ApiError(409, "DOCUMENT_CHANGED", "The stored file no longer matches this document.");
        completed = true;
        return Buffer.concat(chunks, received);
      };
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); body?.destroy?.(); reject(new Error("Document read timeout.")); }, PDF_TEXT_LIMITS.timeoutMs); });
      bytes = await Promise.race([download(), timeout]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "DOCUMENT_UNAVAILABLE", "The contract could not be read. Please try again.");
    } finally {
      clearTimeout(timer);
      if (!completed) { controller.abort(); body?.destroy?.(); }
    }
    try {
      const result = await parse(bytes);
      return { ...result, eventId: document.eventId, documentId: document.documentId, contentSha256: document.contentSha256 };
    } catch (error) {
      if (error instanceof PdfTextError) throw error;
      throw new PdfTextError("PDF_READ_FAILED");
    }
  };
}
