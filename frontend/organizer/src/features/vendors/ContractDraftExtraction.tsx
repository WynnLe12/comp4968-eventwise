import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";
import { ContractDraftSaveError, extractContractDraft, type ContractDraftDetails, type ContractExtractionResult } from "./contractsApi";

export function ContractDraftExtraction({ draft, disabled, onExtracted, onReload, onBusy, onReloadRequired }: {
  draft: ContractDraftDetails; disabled: boolean; onExtracted: (result: ContractExtractionResult) => void;
  onReload: () => void; onBusy: (busy: boolean) => void; onReloadRequired: () => void;
}) {
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function extract() {
    if (pending.current || disabled || reloadRequired) return;
    pending.current = true; setExtracting(true); setError(""); onBusy(true);
    try {
      const result = await extractContractDraft(draft.eventId, draft.draftId, draft.version);
      if (active.current) onExtracted(result);
    } catch (failure) {
      if (active.current) {
        setError(failure instanceof Error ? failure.message : "We couldn't extract details. Enter them manually or try again.");
        if (failure instanceof ContractDraftSaveError && failure.reloadRequired) {
          setReloadRequired(true); onReloadRequired();
        }
      }
    } finally {
      pending.current = false;
      if (active.current) setExtracting(false);
      onBusy(false);
    }
  }
  if (draft.status !== "DRAFT" || !draft.documentId || draft.documentContentType !== "application/pdf") return null;
  return <div className="contract-extraction" aria-busy={extracting}>
    <Button variant="secondary" disabled={disabled || extracting || reloadRequired} onClick={() => void extract()}>{extracting ? "Extracting�" : "Extract details"}</Button>
    <p className="contracts-help">Fill missing details from PDF text. Saved edits are kept; review the suggestions before confirming.</p>
    {extracting && <p role="status">Reading the PDF. This may take a few seconds�</p>}
    {error && <p role="alert" className="contract-form-message">{error}</p>}
    {reloadRequired && <Button variant="secondary" disabled={extracting} onClick={onReload}>Reload details</Button>}
  </div>;
}
