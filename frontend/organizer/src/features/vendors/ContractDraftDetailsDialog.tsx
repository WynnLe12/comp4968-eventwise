import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Modal } from "../../components/ui";
import { ErrorState, LoadingState } from "../../components/page";
import { useResource } from "../../hooks/useResource";
import { formatCalendarDate } from "../../utils/dateFormat";
import { fetchBudgetCategories } from "../budgets/budgetApi";
import { vendorService } from "../../services/vendorService";
import { getDocumentDownloadUrl } from "../documents/documentsApi";
import { fetchContractDraft, type ContractDraftDetails } from "./contractsApi";

function amount(value: string | null, currency: string | null) {
  if (value === null) return "Not set";
  if (!currency) return value + " (currency not set)";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value)); }
  catch { return value + " " + currency; }
}

export function ContractDraftDetailsDialog({ eventId, draftId, onClose }: { eventId: string; draftId: string; onClose: () => void }) {
  const load = useCallback(() => fetchContractDraft(eventId, draftId), [eventId, draftId]);
  const { data, loading, error, reload } = useResource(load);
  return <Modal title="Contract details" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
    {loading ? <LoadingState label="Loading contract details..." /> : error ?
      <ErrorState message={error instanceof Error ? error.message : "We couldn't load this draft."} onRetry={reload} /> :
      data && <Details key={data.version} draft={data} />}
  </Modal>;
}

function Details({ draft }: { draft: ContractDraftDetails }) {
  const loadReferences = useCallback(async () => {
    const [categories, vendors] = await Promise.allSettled([
      draft.categoryId ? fetchBudgetCategories(draft.eventId) : Promise.resolve(null),
      draft.vendorId ? vendorService.list(draft.eventId) : Promise.resolve(null),
    ]);
    return {
      category: categories.status === "fulfilled" ? categories.value?.categories.find(category => category.categoryId === draft.categoryId)?.name : undefined,
      vendor: vendors.status === "fulfilled" ? vendors.value?.find(vendor => vendor.id === draft.vendorId)?.name : undefined,
    };
  }, [draft.eventId, draft.categoryId, draft.vendorId]);
  const references = useResource(loadReferences);
  const [opening, setOpening] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function openDocument() {
    if (!draft.documentId || opening) return;
    setOpening(true); setDocumentError("");
    try {
      const result = await getDocumentDownloadUrl(draft.eventId, draft.documentId);
      if (!mounted.current) return;
      const link = document.createElement("a");
      link.href = result.downloadUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
      document.body.appendChild(link); link.click(); link.remove();
    } catch { if (mounted.current) setDocumentError("We couldn't open the source document. It may have been removed. Please try again."); }
    finally { if (mounted.current) setOpening(false); }
  }
  const status = draft.status === "DRAFT" ? "Needs review" : draft.status === "CONFIRMED" ? "Confirmed" : "Discarded";
  const rows: [string, string][] = [
    ["Expense name", draft.description || "Not set"],
    ["Category", !draft.categoryId ? "Not selected" : references.loading ? "Loading..." : references.data?.category || "Category unavailable"],
    ["Vendor", draft.vendorId ? references.loading ? "Loading..." : references.data?.vendor || "Vendor unavailable" : draft.vendorName ? draft.vendorName + " (not linked)" : "No vendor linked"],
    ["Total amount", amount(draft.totalAmount, draft.currencyCode)],
    ["Currency", draft.currencyCode || "Not set"],
    ["Deposit required", amount(draft.depositAmount, draft.currencyCode)],
    ["Due date", formatCalendarDate(draft.dueDate, "No due date")],
    ["Expense action", draft.saveAction === "CREATE_EXPENSE" ? "Create a new expense" : "Update an existing expense"],
  ];
  return <div className="contract-details">
    <Badge tone={draft.status === "CONFIRMED" ? "success" : draft.status === "DRAFT" ? "warning" : "neutral"}>{status}</Badge>
    <section>
      <h3>Source document</h3>
      <p>{draft.documentFilename || "Source document unavailable"}</p>
      {draft.documentId && <Button variant="secondary" disabled={opening} onClick={() => void openDocument()}>{opening ? "Opening..." : "Open source document"}</Button>}
      {documentError && <p role="alert">{documentError}</p>}
    </section>
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="contracts-help">A deposit requirement does not record a payment. Payments are managed separately in Expenses.</p>
    {draft.status === "CONFIRMED" && <p>This draft has been confirmed and saved to expenses.</p>}
  </div>;
}
