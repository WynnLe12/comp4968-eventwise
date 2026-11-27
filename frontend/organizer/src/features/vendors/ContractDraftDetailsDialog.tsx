import { ContractDraftExtraction } from "./ContractDraftExtraction";
import { contractExtractionFeedback } from "./contractExtractionFeedback";
import { formatContractAmount } from "./contractAmount";
import { ContractDraftConfirmation } from "./ContractDraftConfirmation";
import { ContractDraftForm } from "./ContractDraftForm";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Modal } from "../../components/ui";
import { ErrorState, LoadingState } from "../../components/page";
import { useResource } from "../../hooks/useResource";
import { formatCalendarDate } from "../../utils/dateFormat";
import { fetchBudgetCategories } from "../budgets/budgetApi";
import { vendorService } from "../../services/vendorService";
import { getDocumentDownloadUrl } from "../documents/documentsApi";
import { fetchContractDraft, type ContractDraftDetails } from "./contractsApi";



export function ContractDraftDetailsDialog({ eventId, draftId, onClose, onSaved, initialNotice = "" }: { eventId: string; draftId: string; onClose: () => void; onSaved: (draft: ContractDraftDetails) => void; initialNotice?: string }) {
  const load = useCallback(() => fetchContractDraft(eventId, draftId), [eventId, draftId]);
  const { data, loading, error, reload, update } = useResource(load);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(initialNotice);
  const saved = (draft: ContractDraftDetails, message?: string) => { update(() => draft); setNotice(message ?? (draft.status === "CONFIRMED" ? "Contract confirmed and saved to expenses." : "Draft saved. No expense was created.")); onSaved(draft); };
  return <Modal title="Contract details" onClose={() => { if (!busy) onClose(); }} footer={<Button variant="secondary" disabled={busy} onClick={onClose}>Close</Button>}>
    {notice && <p role="status">{notice}</p>}
    {loading ? <LoadingState label="Loading contract details..." /> : error ?
      <ErrorState message={error instanceof Error ? error.message : "We couldn't load this draft."} onRetry={reload} /> :
      data && <Details key={data.version} draft={data} onSaved={saved} onReload={() => { setNotice(""); reload(); }} onBusy={value => { setBusy(value); if (value) setNotice(""); }} />}
  </Modal>;
}

function Details({ draft, onSaved, onReload, onBusy }: { draft: ContractDraftDetails; onSaved: (draft: ContractDraftDetails, message?: string) => void; onReload: () => void; onBusy: (busy: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractionNeedsReload, setExtractionNeedsReload] = useState(false);
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
    ["Total amount", formatContractAmount(draft.totalAmount)],
    ["Deposit required", formatContractAmount(draft.depositAmount)],
    ["Due date", formatCalendarDate(draft.dueDate, "No due date")],
    ["Expense action", draft.saveAction === "CREATE_EXPENSE" ? "Create a new expense" : "Update an existing expense"],
  ];
  return <div className="contract-details">
    <Badge tone={draft.status === "CONFIRMED" ? "success" : draft.status === "DRAFT" ? "warning" : "neutral"}>{status}</Badge>
    <section>
      <h3>Source document</h3>
      <p>{draft.documentFilename || "Source document unavailable"}</p>
      {draft.documentId && <Button variant="secondary" disabled={opening || confirming || extracting} onClick={() => void openDocument()}>{opening ? "Opening..." : "Open Source Document"}</Button>}
      {documentError && <p role="alert">{documentError}</p>}
    </section>
    {editing ? <ContractDraftForm draft={draft} onSaved={onSaved} onReload={onReload} onBusy={onBusy} onCancel={() => setEditing(false)} /> : <>
    {draft.status === "DRAFT" && <Button variant="secondary" disabled={confirming || extracting || extractionNeedsReload} onClick={() => setEditing(true)}>Edit Draft</Button>}
    <ContractDraftExtraction draft={draft} disabled={confirming || extractionNeedsReload}
      onExtracted={result => onSaved(result.draft, contractExtractionFeedback(result))} onReload={onReload}
      onReloadRequired={() => setExtractionNeedsReload(true)} onBusy={value => { setExtracting(value); onBusy(value); }} />
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="contracts-help">A deposit requirement does not record a payment. Payments are managed separately in Expenses.</p>
    {draft.status === "CONFIRMED" && <p>This draft has been confirmed and saved to expenses.</p>}
    {draft.status === "DRAFT" && !extracting && !extractionNeedsReload && <ContractDraftConfirmation draft={draft} onConfirmed={onSaved} onReload={onReload}
      referenceIssue={references.loading ? "Checking the selected category and vendor..." : draft.categoryId && !references.data?.category ? "The selected category could not be loaded. Reload details before confirming." : draft.vendorId && !references.data?.vendor ? "The selected vendor could not be loaded. Reload details before confirming." : ""}
      onBusy={busy => { setConfirming(busy); onBusy(busy); }} />}
    </>}
  </div>;
}
