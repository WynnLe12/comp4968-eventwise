import { ApiError } from "../../expense-service/errors";
import { parseId } from "../../expense-service/services/validation";
import { parseDraftVersion } from "../services/draftValidation";
import type { Draft } from "../types";
import { createDocumentTextReader, type VerifiedTextDocument } from "./documentTextReader";
import { suggestContractFields, type ContractFieldSuggestions } from "./contractFieldSuggestions";
import { PdfTextError, type PdfTextResult } from "./pdfTextTypes";
import type { ExtractionFill } from "./draftExtractionPatch";

export interface DraftExtractionSnapshot {
  draft: Draft;
  document: VerifiedTextDocument;
}
export type DraftExtractionResult = Omit<ExtractionFill, "changes"> & { draft: Draft };
export interface DraftExtractionStore {
  snapshot(eventId: string, draftId: string, sub: string, version: string): Promise<DraftExtractionSnapshot>;
  apply(snapshot: DraftExtractionSnapshot, sub: string, suggestions: ContractFieldSuggestions): Promise<DraftExtractionResult>;
}

/** The I/O and parsing phase holds no database transaction. Async Lambda jobs can reuse the same phases. */
export class DraftExtractionService {
  constructor(private readonly store: DraftExtractionStore,
    private readonly read: (document: VerifiedTextDocument) => Promise<PdfTextResult> = createDocumentTextReader(),
    private readonly suggest: (text: PdfTextResult) => ContractFieldSuggestions = suggestContractFields) {}

  async extract(eventId: string, draftId: string, sub: string, body: unknown): Promise<DraftExtractionResult> {
    parseId(eventId, "eventId", true); parseId(draftId, "draftId", true);
    if (typeof sub !== "string" || !sub || sub.trim() !== sub || sub.length > 128) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    const { version } = parseDraftVersion(body);
    try {
      const snapshot = await this.store.snapshot(eventId, draftId, sub, version);
      const text = await this.read(snapshot.document);
      return await this.store.apply(snapshot, sub, this.suggest(text));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof PdfTextError) throw new ApiError(422, error.code, error.message);
      throw new ApiError(500, "EXTRACTION_FAILED", "We couldn't extract contract details. Enter them manually or try again.");
    }
  }
}
