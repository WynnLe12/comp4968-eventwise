import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "../../expense-service/errors";

export interface DraftDocument {
  documentId: string;
  s3ObjectKey: string;
  contentType: string;
  sizeBytes: string;
  contentSha256: string | null;
}
export type DocumentFingerprint = (document: DraftDocument) => Promise<string>;

/** Only for older uploads without a backend fingerprint; never accept one from a client. */
export function createDocumentFingerprint(
  client = new S3Client({}),
  bucket = process.env.DOCUMENTS_BUCKET_NAME ?? "",
): DocumentFingerprint {
  return async document => {
    if (!bucket) throw new ApiError(503, "SERVICE_UNAVAILABLE", "Document storage is not configured.");
    const expected = Number(document.sizeBytes);
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > 10 * 1024 * 1024) {
      throw new ApiError(422, "INVALID_DOCUMENT", "Choose a contract up to 10 MB.");
    }
    try {
      const object = await client.send(new GetObjectCommand({
        Bucket: bucket, Key: document.s3ObjectKey,
      }), { abortSignal: AbortSignal.timeout(10000) });
      if (object.ContentLength !== expected || object.ContentType !== document.contentType ||
          !object.Body || !(Symbol.asyncIterator in object.Body)) {
        throw new ApiError(409, "DOCUMENT_CHANGED", "The stored file no longer matches this document.");
      }
      const digest = createHash("sha256");
      let received = 0;
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        if (received > expected) throw new ApiError(409, "DOCUMENT_CHANGED", "The stored file size changed.");
        digest.update(chunk);
      }
      if (received !== expected) throw new ApiError(409, "DOCUMENT_CHANGED", "The stored file size changed.");
      return digest.digest("hex");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // SDK errors may include private object keys or credentials.
      throw new ApiError(503, "DOCUMENT_UNAVAILABLE", "The contract could not be read. Please try again.");
    }
  };
}
