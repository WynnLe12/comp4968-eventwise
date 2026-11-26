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

async function contractRequest(eventId: string, suffix: string): Promise<unknown> {
  let token: string | undefined;
  try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); }
  catch { /* Present session guidance below. */ }
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  let response: Response;
  try {
    response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/contract-drafts" + suffix), {
      headers: { Authorization: "Bearer " + token },
    });
  } catch { throw new Error("We couldn't reach the server. Check your connection and try again."); }
  if (!response.ok) {
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
