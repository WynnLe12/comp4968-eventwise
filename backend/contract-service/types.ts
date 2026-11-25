export const DRAFT_STATUSES = ["DRAFT", "CONFIRMED", "REJECTED"] as const;
export type DraftStatus = typeof DRAFT_STATUSES[number];
export const SAVE_ACTIONS = ["CREATE_EXPENSE", "UPDATE_EXPENSE"] as const;
export type SaveAction = typeof SAVE_ACTIONS[number];

/** Drafts may be incomplete; confirmation applies the financial requirements. */
export interface DraftFields {
  description: string | null;
  categoryId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  totalAmount: string | null;
  /** An obligation from the contract, never a recorded payment. */
  depositAmount: string | null;
  dueDate: string | null;
  currencyCode: string | null;
  saveAction: SaveAction;
  targetExpenseId: string | null;
}

export interface DraftPatch {
  version: string;
  changes: Partial<DraftFields>;
}

export interface DraftQuery {
  limit: number;
  offset: number;
  status?: DraftStatus;
}

export interface Draft extends DraftFields {
  draftId: string;
  eventId: string;
  documentId: string | null;
  documentFilename: string | null;
  documentContentType: string | null;
  status: DraftStatus;
  version: string;
  confirmedExpenseId: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface DraftPage {
  data: Draft[];
  total: number;
  limit: number;
  offset: number;
}

export interface DraftReader {
  list(eventId: string, sub: string, query: DraftQuery): Promise<DraftPage>;
  get(eventId: string, draftId: string, sub: string): Promise<Draft | null>;
}

export interface DraftCreation {
  draftId: string;
  created: boolean;
}

export interface DraftCreator {
  create(eventId: string, documentId: string, sub: string): Promise<DraftCreation>;
}

export interface DraftUpdater {
  update(eventId: string, draftId: string, sub: string, body: unknown): Promise<Draft>;
}

export interface DraftDiscarder {
  discard(eventId: string, draftId: string, sub: string, body: unknown): Promise<Draft>;
}

export interface DraftConfirmation {
  draft: Draft;
  created: boolean;
}

export interface DraftConfirmer {
  confirm(eventId: string, draftId: string, sub: string, body: unknown): Promise<DraftConfirmation>;
}
