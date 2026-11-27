import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Modal, SelectField } from "../../components/ui";
import { EmptyState, ErrorState, LoadingState } from "../../components/page";
import { useResource } from "../../hooks/useResource";
import { fetchContractDocuments } from "./contractDocuments";
import { createContractDraft } from "./contractsApi";

export function ChooseContractDocumentDialog({ eventId, onClose, onCreated }: {
  eventId: string; onClose: () => void; onCreated: (result: { draftId: string; created: boolean }) => void;
}) {
  const navigate = useNavigate();
  const load = useCallback(() => fetchContractDocuments(eventId), [eventId]);
  const { data: documents, loading, error: loadError, reload } = useResource(load);
  const [documentId, setDocumentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const selected = documents?.find(document => document.documentId === documentId);
  const close = () => { if (!pending.current) onClose(); };
  async function create() {
    if (pending.current || loading || loadError || !selected) return;
    pending.current = true; setCreating(true); setError("");
    try {
      const result = await createContractDraft(eventId, selected.documentId);
      if (active.current) onCreated(result);
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : "We couldn't create the draft. Please try again.");
    } finally {
      pending.current = false;
      if (active.current) setCreating(false);
    }
  }
  const openDocuments = () => { if (!pending.current) navigate("/app/documents"); };
  return <Modal title="Choose a contract document" onClose={close} footer={<>
    <Button variant="secondary" disabled={creating} onClick={close}>Cancel</Button>
    <Button disabled={creating || loading || Boolean(loadError) || !selected} onClick={() => void create()}>{creating ? "Opening draft..." : "Create draft"}</Button>
  </>}>
    <p>Choose a file uploaded to this event. If this file already has a draft, we'll open it instead of creating another.</p>
    <p className="contracts-help">PDF, JPG or PNG up to 10 MB. Creating a draft does not add an expense.</p>
    {loading ? <LoadingState label="Loading uploaded documents..." /> : loadError ?
      <ErrorState message={loadError instanceof Error ? loadError.message : "We couldn't load documents."} onRetry={reload} /> :
      !documents?.length ? <EmptyState title="No supported documents yet" message="Upload a PDF, JPG or PNG in Documents, then return here to create a draft."
        action={<Button variant="secondary" onClick={openDocuments}>Open Documents</Button>} /> : <>
        <SelectField label="Document" value={documentId} disabled={creating} options={[
          { value: "", label: "Select an uploaded document" },
          ...documents.map(document => ({ value: document.documentId, label: document.filename + " (" + (Number(document.sizeBytes) / 1024).toFixed(1) + " KB)" })),
        ]} onChange={event => { setDocumentId(event.target.value); setError(""); }} />
        <div className="contract-form-actions"><Button variant="ghost" disabled={creating} onClick={() => { setError(""); reload(); }}>Refresh documents</Button></div>
      </>}
    {error && <p role="alert" className="contract-form-message">{error}</p>}
  </Modal>;
}
