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

export async function fetchContractDrafts(eventId: string, offset = 0): Promise<ContractDraftPage> {
  let token: string | undefined;
  try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); }
  catch { /* Present session guidance below. */ }
  if (!token) throw new Error("Your session has expired. Please sign in again.");
  let response: Response;
  try {
    response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/contract-drafts?limit=20&offset=" + offset), {
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
  const invalid = () => new Error("We couldn't read this event's contract drafts. Please try again.");
  const page: ContractDraftPage = await response.json().catch(() => { throw invalid(); });
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
