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
