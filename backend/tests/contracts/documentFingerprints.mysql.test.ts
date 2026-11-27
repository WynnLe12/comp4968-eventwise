import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader } from "mysql2/promise";
import { DocumentRepository } from "../../document-service/repositories/documentRepository";
import { closeDatabasePool, getDatabasePool } from "../../shared/db/pool";

after(closeDatabasePool);
test("MySQL documents persist trusted fingerprints and repeated registration keeps the original", {
  skip: process.env.EVENTWISE_MYSQL_TEST !== "1",
}, async () => {
  const [event] = await getDatabasePool().execute<ResultSetHeader>("INSERT INTO events (name) VALUES ('Document fingerprint test')");
  const eventId = String(event.insertId), repository = new DocumentRepository();
  const input = { eventId, uploadedBySub: "fixture-user", s3ObjectKey: "events/" + eventId + "/documents/" + randomUUID(),
    originalFilename: "contract.pdf", contentType: "application/pdf", sizeBytes: 100,
    contentSha256: createHash("sha256").update("fixture bytes").digest("hex") };
  try {
    const id = await repository.create(input);
    assert.equal((await repository.getById(eventId, id))?.content_sha256, input.contentSha256);
    assert.equal((await repository.listByEvent(eventId))[0].content_sha256, input.contentSha256);
    await getDatabasePool().execute("UPDATE event_documents SET content_sha256 = NULL WHERE document_id = ?", [id]);
    assert.equal(await repository.create(input), id);
    assert.equal((await repository.getById(eventId, id))?.content_sha256, input.contentSha256);
    assert.equal(await repository.create({ ...input, contentSha256: "b".repeat(64) }), id);
    assert.equal((await repository.getByS3Key(eventId, input.s3ObjectKey))?.content_sha256, input.contentSha256);
    const second = await repository.create({ ...input, originalFilename: "renamed.pdf", s3ObjectKey: input.s3ObjectKey + "-copy" });
    assert.notEqual(second, id); // F6 allows uploads; F15 will deduplicate their drafts.
    assert.equal((await repository.getById(eventId, second))?.content_sha256, input.contentSha256);
  } finally { await getDatabasePool().execute("DELETE FROM events WHERE event_id = ?", [eventId]); }
});
