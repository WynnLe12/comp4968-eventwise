import { formatContractAmount } from "./contractAmount";
import { ContractDraftDetailsDialog } from "./ContractDraftDetailsDialog";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card } from "../../components/ui";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { useResource } from "../../hooks/useResource";
import { useEvents } from "../events/EventsContext";
import { fetchContractDrafts, type ContractDraftSummary } from "./contractsApi";
import "./contracts.css";

const statuses = {
  DRAFT: { label: "Needs review", tone: "warning" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  REJECTED: { label: "Discarded", tone: "neutral" },
};
function draftAmount(draft: ContractDraftSummary) {
  return draft.totalAmount === null ? "Amount not set" : formatContractAmount(draft.totalAmount);
}
export function Contracts() {
  const { selectedId, userId } = useEvents();
  if (!selectedId || !userId) return <EmptyState title="Select an event" message="Choose an event to view its contract drafts." />;
  return <EventContracts key={JSON.stringify([userId, selectedId])} eventId={selectedId} />;
}
function EventContracts({ eventId }: { eventId: string }) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  return <>
    <PageHeader page="contracts" action={<Button variant="secondary" onClick={() => navigate("/app/documents")}>Open Documents</Button>} />
    <p className="contracts-help">Review contract details before adding them to expenses. Automatic extraction is not available yet.</p>
    <DraftList key={offset} eventId={eventId} offset={offset} onPage={setOffset} />
  </>;
}
function DraftList({ eventId, offset, onPage }: { eventId: string; offset: number; onPage: (offset: number) => void }) {
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const load = useCallback(() => fetchContractDrafts(eventId, offset), [eventId, offset]);
  const { data: page, loading, error, reload, update } = useResource(load);
  if (loading) return <LoadingState label="Loading contract drafts..." />;
  if (error) return <ErrorState message={error instanceof Error ? error.message : "We couldn't load contract drafts."} onRetry={reload} />;
  if (!page) return null;
  return <><Card className="contracts-list">
    <div className="contracts-list-head">
      <h2>Saved drafts <small>({page.total})</small></h2>
      <Button variant="secondary" onClick={reload}>Refresh</Button>
    </div>
    {page.data.length === 0 ? <EmptyState title={offset ? "No drafts on this page" : "No contract drafts yet"}
      message={offset ? "Go back to see earlier drafts." : "Uploaded documents will appear here once a contract draft has been created."} /> :
      <ul className="contracts-rows">
        {page.data.map(draft => <li key={draft.draftId}>
          <div className="contracts-draft-name">
            <h3>{draft.description || draft.documentFilename || "Untitled contract"}</h3>
            {draft.description && draft.documentFilename && <p>{draft.documentFilename}</p>}
            {draft.status === "CONFIRMED" && <small>Saved to expenses</small>}
          </div>
          <strong>{draftAmount(draft)}</strong>
          <Badge tone={statuses[draft.status].tone}>{statuses[draft.status].label}</Badge>
          <Button variant="secondary" onClick={() => setSelectedDraftId(draft.draftId)}>Review details</Button>
        </li>)}
      </ul>}
    <div className="contracts-pagination">
      <span>{page.data.length ? "Showing " + (offset + 1) + (page.data.length > 1 ? " to " + (offset + page.data.length) : "") : "Showing 0"} of {page.total} {page.total === 1 ? "draft" : "drafts"}</span>
      <Button variant="secondary" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - page.limit))}>Previous</Button>
      <Button variant="secondary" disabled={offset + page.limit >= page.total} onClick={() => onPage(offset + page.limit)}>Next</Button>
    </div>
  </Card>
    {selectedDraftId && <ContractDraftDetailsDialog key={selectedDraftId} eventId={eventId} draftId={selectedDraftId} onSaved={saved => update(current => ({ ...current, data: current.data.map(row => row.draftId === saved.draftId ? saved : row) }))} onClose={() => setSelectedDraftId(null)} />}
  </>;
}
