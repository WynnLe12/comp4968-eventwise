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
    if (response.status === 409) {
      const messages: Record<string, string> = {
        DRAFT_CHANGED: "This draft changed in another tab. Reload the latest version before continuing.",
        DRAFT_NOT_EDITABLE: "This draft is no longer editable. Reload to see its current status.",
        DOCUMENT_UNVERIFIED: "The source document could not be verified. Reopen the document and reload this draft before confirming.",
        CONFIRMATION_UNAVAILABLE: "This draft has already been confirmed. Reload and review its saved expense.",
      };
      throw new ContractDraftSaveError(messages[result?.error?.code] ?? "This draft could not be saved. Reload its latest details before continuing.", {}, true);
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
      ![draft.documentId, draft.documentFilename, draft.description, draft.currencyCode, draft.categoryId,
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
