import { fetchDocuments, type EventDocument } from "../documents/documentsApi";

export function eligibleContractDocuments(documents: EventDocument[], eventId: string): EventDocument[] {
  const invalid = () => new Error("We couldn't read this event's documents. Please try again.");
  if (!Array.isArray(documents)) throw invalid();
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document || document.eventId !== eventId || typeof document.documentId !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(document.documentId) || BigInt(document.documentId) > 18446744073709551615n || ids.has(document.documentId) ||
        typeof document.filename !== "string" || !document.filename.trim() || typeof document.contentType !== "string" ||
        typeof document.sizeBytes !== "string" || !/^[0-9]+$/.test(document.sizeBytes)) throw invalid();
    ids.add(document.documentId);
  }
  return documents.filter(document => ["application/pdf", "image/jpeg", "image/png"].includes(document.contentType) &&
    BigInt(document.sizeBytes) > 0n && BigInt(document.sizeBytes) <= 10485760n);
}

export async function fetchContractDocuments(eventId: string): Promise<EventDocument[]> {
  return eligibleContractDocuments(await fetchDocuments(eventId), eventId);
}
