import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";
import { ContractDraftSaveError, discardContractDraft, type ContractDraftDetails } from "./contractsApi";

export function ContractDraftDiscard({ draft, disabled, onDiscarded, onReload, onBusy, onIntent }: {
  draft: ContractDraftDetails; disabled: boolean; onDiscarded: (draft: ContractDraftDetails) => void;
  onReload: () => void; onBusy: (busy: boolean) => void; onIntent: (asking: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const container = useRef<HTMLDivElement>(null);
  const previouslyAsking = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (asking) container.current?.querySelector<HTMLElement>("h3")?.focus();
    else if (previouslyAsking.current) container.current?.querySelector<HTMLButtonElement>("button")?.focus();
    previouslyAsking.current = asking;
  }, [asking]);
  function ask(value: boolean) {
    if (pending.current) return;
    setAsking(value); setError(""); onIntent(value);
  }
  async function discard() {
    if (!asking || pending.current || disabled || reloadRequired) return;
    pending.current = true; setDiscarding(true); setError(""); onBusy(true);
    try {
      const saved = await discardContractDraft(draft.eventId, draft.draftId, draft.version);
      if (active.current) onDiscarded(saved);
    } catch (failure) {
      if (active.current) {
        setError(failure instanceof Error ? failure.message : "We couldn't discard this draft. Please try again.");
        setReloadRequired(failure instanceof ContractDraftSaveError && failure.reloadRequired);
      }
    } finally {
      pending.current = false;
      if (active.current) setDiscarding(false);
      onBusy(false);
    }
  }
  if (draft.status !== "DRAFT") return null;
  return <div ref={container} className="contract-discard">
    {asking ? <section className="contract-confirmation" aria-label="Discard draft confirmation" aria-busy={discarding}>
      <h3 tabIndex={-1}>Discard This Draft?</h3>
      <p><strong>{draft.description || draft.documentFilename || "Untitled contract"}</strong></p>
      <p>The draft will be marked as discarded and can no longer be edited or confirmed. Your uploaded document will be kept. Expenses and payments will stay unchanged.</p>
      {error && <p role="alert" className="contract-form-message">{error}</p>}
      <div className="contract-form-actions">
        {reloadRequired ? <Button variant="secondary" disabled={discarding} onClick={onReload}>Reload Details</Button> : <>
          <Button variant="secondary" disabled={discarding} onClick={() => ask(false)}>Keep Draft</Button>
          <Button variant="danger" disabled={discarding || disabled} onClick={() => void discard()}>{discarding ? "Discarding..." : "Discard Draft"}</Button>
        </>}
      </div>
    </section> : <><h3>Don't Need This Draft?</h3><p className="contracts-help">Discard the draft and keep your uploaded document.</p><Button variant="danger" disabled={disabled} onClick={() => ask(true)}>Discard Draft</Button></>}
  </div>;
}
