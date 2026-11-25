import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "../../expense-service/errors";
import { createDocumentFingerprint, type DraftDocument } from "../../contract-service/services/documentFingerprint";

const document: DraftDocument = { documentId: "12", s3ObjectKey: "events/1/documents/fixture",
  contentType: "application/pdf", sizeBytes: "6", contentSha256: null };
function fixture(chunks: Buffer[], length = 6, contentType = "application/pdf") {
  const client = new S3Client({ region: "us-west-2" });
  client.send = (async (command: unknown) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Key, document.s3ObjectKey);
    return { ContentLength: length, ContentType: contentType, Body: Readable.from(chunks) };
  }) as typeof client.send;
  return { client, fingerprint: createDocumentFingerprint(client, "private-test-bucket") };
}
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;

test("older documents are fingerprinted from streamed S3 bytes", async () => {
  const f = fixture([Buffer.from("abc"), Buffer.from("def")]);
  assert.equal(await f.fingerprint(document), createHash("sha256").update("abcdef").digest("hex"));
});

test("fingerprinting rejects changed metadata and truncated or oversized streams", async () => {
  for (const f of [fixture([], 7), fixture([], 6, "image/png"),
    fixture([Buffer.from("abc")]), fixture([Buffer.from("abcdefg")])]) {
    await assert.rejects(f.fingerprint(document), status(409));
  }
  await assert.rejects(fixture([]).fingerprint({ ...document, sizeBytes: "10485761" }), status(422));
});

test("unavailable storage returns a retryable error without private SDK details", async () => {
  const f = fixture([]);
  f.client.send = (async () => { throw new Error("private object key and credentials"); }) as typeof f.client.send;
  await assert.rejects(f.fingerprint(document), error => error instanceof ApiError &&
    error.status === 503 && !error.message.includes("private"));
  await assert.rejects(createDocumentFingerprint(f.client, "")(document), status(503));
});
