import { ChooseContractDocumentDialog } from "./ChooseContractDocumentDialog";
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<{ draftId: string; notice: string } | null>(null);
  return <>
    <PageHeader page="contracts" action={<div className="contract-page-actions">
      <Button variant="secondary" onClick={() => navigate("/app/documents")}>Open Documents</Button>
      <Button onClick={() => setChoosing(true)}>Choose document</Button>
    </div>} />
    <p className="contracts-help">Review contract details before adding them to expenses. Automatic extraction is not available yet.</p>
    <DraftList key={JSON.stringify([offset, refreshKey])} eventId={eventId} offset={offset} onPage={setOffset}
      onSelect={draftId => setSelectedDraft({ draftId, notice: "" })} onChoose={() => setChoosing(true)} />
    {choosing && <ChooseContractDocumentDialog eventId={eventId} onClose={() => setChoosing(false)} onCreated={result => {
      setChoosing(false); setOffset(0); setRefreshKey(value => value + 1);
      setSelectedDraft({ draftId: result.draftId, notice: result.created ? "Draft created. Review and save its details before confirming an expense." : "This file already has a saved draft. We opened the existing draft; no duplicate was created." });
    }} />}
    {selectedDraft && <ContractDraftDetailsDialog key={selectedDraft.draftId} eventId={eventId} draftId={selectedDraft.draftId}
      initialNotice={selectedDraft.notice} onSaved={() => setRefreshKey(value => value + 1)} onClose={() => setSelectedDraft(null)} />}
  </>;
}
function DraftList({ eventId, offset, onPage, onSelect, onChoose }: { eventId: string; offset: number; onPage: (offset: number) => void; onSelect: (draftId: string) => void; onChoose: () => void }) {
  const load = useCallback(() => fetchContractDrafts(eventId, offset), [eventId, offset]);
  const { data: page, loading, error, reload } = useResource(load);
  if (loading) return <LoadingState label="Loading contract drafts..." />;
  if (error) return <ErrorState message={error instanceof Error ? error.message : "We couldn't load contract drafts."} onRetry={reload} />;
  if (!page) return null;
  return <><Card className="contracts-list">
    <div className="contracts-list-head">
      <h2>Saved drafts <small>({page.total})</small></h2>
      <Button variant="secondary" onClick={reload}>Refresh</Button>
    </div>
    {page.data.length === 0 ? <EmptyState title={offset ? "No drafts on this page" : "No contract drafts yet"}
      message={offset ? "Go back to see earlier drafts." : "Choose an uploaded document to start reviewing a contract."}
      action={!offset ? <Button onClick={onChoose}>Choose document</Button> : undefined} /> :
      <ul className="contracts-rows">
        {page.data.map(draft => <li key={draft.draftId}>
          <div className="contracts-draft-name">
            <h3>{draft.description || draft.documentFilename || "Untitled contract"}</h3>
            {draft.description && draft.documentFilename && <p>{draft.documentFilename}</p>}
            {draft.status === "CONFIRMED" && <small>Saved to expenses</small>}
          </div>
          <strong>{draftAmount(draft)}</strong>
          <Badge tone={statuses[draft.status].tone}>{statuses[draft.status].label}</Badge>
          <Button variant="secondary" onClick={() => onSelect(draft.draftId)}>Review details</Button>
        </li>)}
      </ul>}
    <div className="contracts-pagination">
      <span>{page.data.length ? "Showing " + (offset + 1) + (page.data.length > 1 ? " to " + (offset + page.data.length) : "") : "Showing 0"} of {page.total} {page.total === 1 ? "draft" : "drafts"}</span>
      <Button variant="secondary" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - page.limit))}>Previous</Button>
      <Button variant="secondary" disabled={offset + page.limit >= page.total} onClick={() => onPage(offset + page.limit)}>Next</Button>
    </div>
  </Card>
  </>;
}
