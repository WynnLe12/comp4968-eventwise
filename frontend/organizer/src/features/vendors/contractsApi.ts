import { requireAuthSession } from "../auth/services/authService";
import { apiUrl } from "../../services/apiConfig";

export interface ContractDraftSummary {
  draftId: string;
  eventId: string;
  documentFilename: string | null;
  description: string | null;
  totalAmount: string | null;
  currencyCode: string | null;
  status: "DRAFT" | "CONFIRMED" | "REJECTED";
}
export interface ContractDraftPage { data: ContractDraftSummary[]; total: number; limit: number; offset: number }

async function contractRequest(eventId: string, suffix: string, body?: unknown, method: "GET" | "PATCH" | "POST" = body === undefined ? "GET" : "PATCH"): Promise<unknown> {
  let token: string | undefined;
  try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); }
  catch { /* Present session guidance below. */ }
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  let response: Response;
  try {
    response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/contract-drafts" + suffix), {
      method,
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error("We couldn't reach the server. Check your connection and try again."); }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    if (method === "POST" && suffix === "" && ![401, 403].includes(response.status)) {
      const messages: Record<string, string> = {
        INVALID_DOCUMENT: "Choose a completed PDF, JPG or PNG upload up to 10 MB.",
        DOCUMENT_CHANGED: "This document changed. Refresh the document list and choose it again.",
        DUPLICATE_CONTRACT: "This file has conflicting saved drafts. Close this picker and review the existing drafts.",
        DOCUMENT_UNAVAILABLE: "The source file couldn't be read. Check it in Documents and try again.",
      };
      throw new Error(messages[result?.error?.code] ?? (response.status === 404 ? "This document is no longer available. Refresh the document list." : "We couldn't create the draft. Please try again."));
    }
    if (method === "POST" && suffix.endsWith("/extract") && ![401, 403, 409].includes(response.status)) {
      const messages: Record<string, string> = {
        PDF_NO_TEXT: "No readable text was found. For a scanned PDF, choose Edit draft and enter the details manually.",
        PDF_PASSWORD_REQUIRED: "This PDF is password protected. Use an unlocked copy or enter the details manually.",
        INVALID_PDF: "This file could not be read as a PDF. Enter the details manually.",
        PDF_READ_FAILED: "We couldn't read this PDF. Enter the details manually.",
        PDF_TOO_LARGE: "Choose a PDF up to 10 MB, or enter the details manually.",
        PDF_PAGE_LIMIT: "This PDF has more than 50 pages. Enter the details manually.",
        PDF_TEXT_LIMIT: "This PDF contains too much text to extract. Enter the details manually.",
        PDF_TIMEOUT: "Reading the PDF took too long. Try again or enter the details manually.",
        PDF_REQUIRED: "Extraction supports PDFs with readable text. Enter image details manually.",
        DOCUMENT_UNAVAILABLE: "We couldn't read the source file. Check it in Documents and try again.",
      };
      throw new Error(messages[result?.error?.code] ?? (response.status === 404 ? "This draft is no longer available. Close it and refresh the list." : "We couldn't extract details. Try again or enter them manually."));
    }
    if (response.status === 409) {
      const messages: Record<string, string> = {
        DOCUMENT_CHANGED: "The source document changed. Reopen it in Documents and reload this draft before continuing.",
        DRAFT_CHANGED: "This draft changed in another tab. Reload the latest version before continuing.",
        DRAFT_NOT_EDITABLE: "This draft is no longer editable. Reload to see its current status.",
        DOCUMENT_UNVERIFIED: "The source document could not be verified. Reopen the document and reload this draft before confirming.",
        CONFIRMATION_UNAVAILABLE: "This draft has already been confirmed. Reload and review its saved expense.",
      };
      throw new ContractDraftSaveError(messages[result?.error?.code] ?? "This draft could not be saved. Reload its latest details before continuing.", {}, true);
    }
    if (method === "POST" && suffix.endsWith("/discard") && ![401, 403].includes(response.status)) {
      throw new Error(response.status === 404 ? "This draft is no longer available. Close it and refresh the list." : "We couldn't discard this draft. Please try again.");
    }
    if (response.status === 422) {
      const fields: Record<string, string> = {};
      const safeFields: Record<string, string> = {
        description: "Use up to 255 characters.", vendorName: "Use up to 150 characters.",
        totalAmount: "Enter an amount of 0 or more, with up to 2 decimals.",
        depositAmount: "Check the deposit amount. It cannot exceed the total.",
        dueDate: "Enter a valid date.", currencyCode: "Enter a three-letter currency code.",
        categoryId: "Choose a category from this event.", vendorId: "Choose a vendor from this event.",
      };
      for (const name of Object.keys(result?.error?.fields ?? {})) if (Object.hasOwn(safeFields, name)) fields[name] = safeFields[name]!;
      throw new ContractDraftSaveError("Please check the highlighted details and try again.", fields);
    }
    const messages: Record<number, string> = {
      401: "Your session has expired. Please sign in again.",
      403: "You don't have access to this event.",
      404: "Contract drafts are unavailable for this event.",
    };
    throw new Error(messages[response.status] ?? "We couldn't load contract drafts. Please try again.");
  }
  return response.json().catch(() => { throw new Error("We couldn't read this event's contract drafts. Please try again."); });
}

export async function fetchContractDrafts(eventId: string, offset = 0): Promise<ContractDraftPage> {
  const invalid = () => new Error("We couldn't read this event's contract drafts. Please try again.");
  const page: ContractDraftPage = await contractRequest(eventId, "?limit=20&offset=" + offset) as ContractDraftPage;
  if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.total) || page.total < 0 ||
      page.offset !== offset || page.limit !== 20 || page.data.length > page.limit) throw invalid();
  const ids = new Set<string>();
  for (const row of page.data) {
    if (!row || row.eventId !== eventId || typeof row.draftId !== "string" || !/^[1-9][0-9]*$/.test(row.draftId) ||
        ids.has(row.draftId) || !["DRAFT", "CONFIRMED", "REJECTED"].includes(row.status) ||
        ![row.documentFilename, row.description, row.currencyCode].every(value => value === null || typeof value === "string") ||
        !(row.totalAmount === null || typeof row.totalAmount === "string" && /^[0-9]{1,10}\.[0-9]{2}$/.test(row.totalAmount))) throw invalid();
    ids.add(row.draftId);
  }
  return page;
}

export interface ContractDraftDetails extends ContractDraftSummary {
  documentContentType: string | null;
  documentId: string | null;
  categoryId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  depositAmount: string | null;
  dueDate: string | null;
  saveAction: "CREATE_EXPENSE" | "UPDATE_EXPENSE";
  targetExpenseId: string | null;
  confirmedExpenseId: string | null;
  version: string;
}

export async function fetchContractDraft(eventId: string, draftId: string): Promise<ContractDraftDetails> {
  const result = await contractRequest(eventId, "/" + encodeURIComponent(draftId)) as { data?: ContractDraftDetails } | null;
  return readContractDraft(result, eventId, draftId);
}

function readContractDraft(result: { data?: ContractDraftDetails } | null, eventId: string, draftId: string): ContractDraftDetails {
  const draft = result?.data;
  const nullableText = (value: unknown) => value === null || typeof value === "string";
  const money = (value: unknown) => value === null || typeof value === "string" && /^[0-9]{1,10}\.[0-9]{2}$/.test(value);
  if (!draft || draft.eventId !== eventId || draft.draftId !== draftId ||
      !["DRAFT", "CONFIRMED", "REJECTED"].includes(draft.status) ||
      !["CREATE_EXPENSE", "UPDATE_EXPENSE"].includes(draft.saveAction) || typeof draft.version !== "string" ||
      ![draft.documentId, draft.documentFilename, draft.documentContentType, draft.description, draft.currencyCode, draft.categoryId,
        draft.vendorId, draft.vendorName, draft.targetExpenseId, draft.confirmedExpenseId].every(nullableText) ||
      !money(draft.totalAmount) || !money(draft.depositAmount) ||
      !(draft.dueDate === null || typeof draft.dueDate === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(draft.dueDate))) {
    throw new Error("We couldn't read this contract draft. Please try again.");
  }
  return draft;
}

export type ContractDraftChanges = Partial<Pick<ContractDraftDetails,
  "description" | "categoryId" | "vendorId" | "vendorName" | "totalAmount" | "depositAmount" | "dueDate" | "currencyCode">>;

export class ContractDraftSaveError extends Error {
  constructor(message: string, public readonly fields: Record<string, string> = {}, public readonly reloadRequired = false) {
    super(message);
    this.name = "ContractDraftSaveError";
  }
}

export async function saveContractDraft(eventId: string, draftId: string, version: string, changes: ContractDraftChanges): Promise<ContractDraftDetails> {
  const body: Record<string, unknown> = { version };
  for (const name of ["description", "categoryId", "vendorId", "vendorName", "totalAmount", "depositAmount", "dueDate", "currencyCode"] as const) {
    if (Object.hasOwn(changes, name)) body[name] = changes[name];
  }
  const result = await contractRequest(eventId, "/" + encodeURIComponent(draftId), body) as { data?: ContractDraftDetails } | null;
  return readContractDraft(result, eventId, draftId);
}

export async function confirmContractDraft(eventId: string, draftId: string, version: string): Promise<{ draft: ContractDraftDetails; created: boolean }> {
  const result = await contractRequest(eventId, "/" + encodeURIComponent(draftId) + "/confirm", { version }, "POST") as { data?: ContractDraftDetails; created?: boolean } | null;
  const draft = readContractDraft(result, eventId, draftId);
  if (draft.status !== "CONFIRMED" || typeof draft.confirmedExpenseId !== "string" ||
      !/^[1-9][0-9]*$/.test(draft.confirmedExpenseId) || typeof result?.created !== "boolean") {
    throw new Error("We couldn't verify the confirmation result. Reload this draft to check whether the expense was saved.");
  }
  return { draft, created: result.created };
}

export async function createContractDraft(eventId: string, documentId: string): Promise<{ draftId: string; created: boolean }> {
  const validId = (value: string) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
  if (!validId(eventId) || !validId(documentId)) throw new Error("Choose a document from the selected event.");
  const result = await contractRequest(eventId, "", { documentId }, "POST") as { data?: { draftId?: string }; created?: boolean } | null;
  if (!result || typeof result.data?.draftId !== "string" || !validId(result.data.draftId) || typeof result.created !== "boolean") {
    throw new Error("We couldn't read the draft result. Refresh the saved drafts before trying again.");
  }
  return { draftId: result.data.draftId, created: result.created };
}


export const CONTRACT_EXTRACTION_FIELDS = ["vendorName", "totalAmount", "depositAmount", "dueDate"] as const;
export type ContractExtractionField = typeof CONTRACT_EXTRACTION_FIELDS[number];
export interface ContractExtractionResult {
  draft: ContractDraftDetails;
  appliedFields: ContractExtractionField[];
  skippedFields: ContractExtractionField[];
  warnings: { field: ContractExtractionField | null; code: string }[];
}
export async function extractContractDraft(eventId: string, draftId: string, version: string): Promise<ContractExtractionResult> {
  const validId = (value: string) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
  if (![eventId, draftId, version].every(validId)) throw new Error("Reload this draft before extracting details.");
  const result = await contractRequest(eventId, "/" + encodeURIComponent(draftId) + "/extract", { version }, "POST") as {
    data?: ContractDraftDetails; appliedFields?: unknown; skippedFields?: unknown; warnings?: unknown;
  } | null;
  const draft = readContractDraft(result, eventId, draftId);
  const fields = (value: unknown): value is ContractExtractionField[] => Array.isArray(value) && value.length <= 4 &&
    new Set(value).size === value.length && value.every(field => CONTRACT_EXTRACTION_FIELDS.includes(field));
  const warningCodes = ["CONFLICTING_VALUES", "AMBIGUOUS_VALUE", "VENDOR_FROM_HEADER", "PARTIAL_TEXT", "SAVED_VALUE_KEPT", "LINKED_VENDOR_KEPT", "AMOUNT_CONFLICT"];
  if (draft.status !== "DRAFT" || !validId(draft.version) || BigInt(draft.version) <= BigInt(version) ||
      !fields(result?.appliedFields) || !fields(result?.skippedFields) ||
      result.appliedFields.some(field => (result.skippedFields as ContractExtractionField[]).includes(field)) ||
      !Array.isArray(result.warnings) || !result.warnings.every(warning => warning &&
        (warning.field === null || CONTRACT_EXTRACTION_FIELDS.includes(warning.field)) && warningCodes.includes(warning.code))) {
    throw new ContractDraftSaveError("We couldn't verify the extraction result. Reload this draft before trying again.", {}, true);
  }
  return { draft, appliedFields: result.appliedFields, skippedFields: result.skippedFields, warnings: result.warnings };
}


export async function discardContractDraft(eventId: string, draftId: string, version: string): Promise<ContractDraftDetails> {
  const validId = (value: string) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
  if (![eventId, draftId, version].every(validId)) throw new Error("Reload this draft before discarding it.");
  const result = await contractRequest(eventId, "/" + encodeURIComponent(draftId) + "/discard", { version }, "POST") as { data?: ContractDraftDetails } | null;
  try {
    const draft = readContractDraft(result, eventId, draftId);
    if (draft.status !== "REJECTED" || !validId(draft.version) || BigInt(draft.version) < BigInt(version) || draft.confirmedExpenseId !== null) throw new Error("Unexpected discard result");
    return draft;
  } catch {
    throw new ContractDraftSaveError("We couldn't verify whether the draft was discarded. Reload its latest details before continuing.", {}, true);
  }
}
