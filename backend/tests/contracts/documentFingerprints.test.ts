import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "../../expense-service/errors";
import { DocumentService } from "../../document-service/services/documentService";
import { DocumentRepository, type CreateDocumentInput, type DocumentRecord } from "../../document-service/repositories/documentRepository";
import { createUploadToken } from "../../document-service/services/uploadToken";

process.env.DOCUMENTS_UPLOAD_SIGNING_SECRET = "public-test-secret-at-least-thirty-two-bytes";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class Repository extends DocumentRepository {
  saved: CreateDocumentInput[] = [];
  existing: DocumentRecord | null = null;
  role: "OWNER" | null = "OWNER";
  override async getMemberRole() { return this.role; }
  override async getByS3Key() { return this.existing; }
  override async listByEvent() { return this.existing ? [this.existing] : []; }
  override async create(input: CreateDocumentInput) { this.saved.push(input); return "9007199254740993"; }
}
function fixture(bytes: Buffer, filename = "contract.pdf", options: { actual?: Buffer; final?: Buffer; conflict?: boolean } = {}) {
  const repository = new Repository();
  const calls: string[] = [];
  const pending = "events/12/pending/" + randomUUID();
  const finalKey = pending.replace("/pending/", "/documents/");
  const object = (content: Buffer) => ({
    ContentLength: bytes.length, ContentType: "application/pdf",
    Metadata: { "uploaded-by": "owner", "original-filename": encodeURIComponent(filename) },
    Body: { transformToByteArray: async () => content },
  });
  const client = new S3Client({ region: "us-west-2" });
  client.send = (async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      calls.push("get:" + command.input.Key);
      return object(command.input.Key === finalKey ? options.final ?? bytes : options.actual ?? bytes);
    }
    if (command instanceof PutObjectCommand) {
      calls.push("put");
      assert.equal(command.input.IfNoneMatch, "*"); assert.equal(command.input.Key, finalKey);
      if (options.conflict) throw Object.assign(new Error("Already finalized"), { name: "PreconditionFailed" });
      return {};
    }
    assert.ok(command instanceof DeleteObjectCommand);
    calls.push("delete"); return {};
  }) as typeof client.send;
  const service = new DocumentService(repository, client, "fixture-private-documents");
  const token = createUploadToken({ eventId: "12", userSub: "owner", key: pending, filename,
    contentType: "application/pdf", sizeBytes: bytes.length, expiresAt: Date.now() + 60000 });
  return { repository, calls, service, complete: () => service.completeUpload("12", "owner", { uploadToken: token }) };
}

test("document completion fingerprints verified file bytes, regardless of filename", async () => {
  const bytes = Buffer.from("%PDF-1.4\nA sample contract");
  const a = fixture(bytes), b = fixture(bytes, "renamed.pdf"), c = fixture(Buffer.from("%PDF-1.4\nAnother contract"));
  for (const f of [a, b, c]) assert.deepEqual(await f.complete(), { documentId: "9007199254740993" });
  assert.equal(a.repository.saved[0].contentSha256, hash(bytes));
  assert.equal(b.repository.saved[0].contentSha256, a.repository.saved[0].contentSha256);
  assert.notEqual(c.repository.saved[0].contentSha256, a.repository.saved[0].contentSha256);
  assert.equal(a.repository.saved[0].sizeBytes, bytes.length);
});

test("document completion stores no fingerprint when membership or uploaded bytes fail validation", async () => {
  const bytes = Buffer.from("%PDF-1.4\nContract");
  const denied = fixture(bytes); denied.repository.role = null;
  await assert.rejects(denied.complete(), error => error instanceof ApiError && error.status === 403);
  assert.deepEqual(denied.calls, []); assert.deepEqual(denied.repository.saved, []);
  const truncated = fixture(bytes, "contract.pdf", { actual: bytes.subarray(1) });
  await assert.rejects(truncated.complete(), error => error instanceof ApiError && error.code === "UPLOAD_MISMATCH");
  assert.equal(truncated.calls.length, 1); assert.deepEqual(truncated.repository.saved, []);
});

test("document finalization retries compare bytes before persisting the fingerprint", async () => {
  const bytes = Buffer.from("%PDF-1.4\nContract");
  const recovered = fixture(bytes, "contract.pdf", { conflict: true });
  await recovered.complete();
  assert.equal(recovered.repository.saved[0].contentSha256, hash(bytes));
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  const mismatch = fixture(bytes, "contract.pdf", { conflict: true, final: changed });
  await assert.rejects(mismatch.complete(), error => error instanceof ApiError && error.code === "UPLOAD_CONFLICT");
  assert.deepEqual(mismatch.repository.saved, []);
});

test("already registered document retries preserve the existing completion response", async () => {
  const f = fixture(Buffer.from("%PDF-1.4\nContract"));
  f.repository.existing = {
    document_id: "123", event_id: "12", uploaded_by_sub: "owner", original_filename: "contract.pdf",
    content_type: "application/pdf", size_bytes: "17", content_sha256: null, created_at: new Date(),
    s3_object_key: "unused",
  } as DocumentRecord;
  assert.deepEqual(await f.complete(), { documentId: "123" });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.repository.saved, []);
  f.repository.existing.content_sha256 = "a".repeat(64);
  const [publicDocument] = await f.service.listDocuments("12", "owner");
  assert.deepEqual(Object.keys(publicDocument).sort(), ["documentId", "eventId", "filename", "contentType", "sizeBytes", "uploadedAt"].sort());
});
