import { formatContractAmount } from "./contractAmount";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";
import { ContractDraftSaveError, confirmContractDraft, type ContractDraftDetails } from "./contractsApi";
import { contractDraftConfirmationIssues } from "./contractConfirmationReadiness";

export function ContractDraftConfirmation({ draft, referenceIssue, onConfirmed, onReload, onBusy }: {
  draft: ContractDraftDetails; referenceIssue: string; onConfirmed: (draft: ContractDraftDetails) => void;
  onReload: () => void; onBusy: (busy: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [reloadRequired, setReloadRequired] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const issues = contractDraftConfirmationIssues(draft);
  if (referenceIssue) issues.push(referenceIssue);
  async function confirm() {
    if (pending.current || issues.length || reloadRequired) return;
    pending.current = true; setConfirming(true); setError(""); onBusy(true);
    try {
      const result = await confirmContractDraft(draft.eventId, draft.draftId, draft.version);
      if (active.current) onConfirmed(result.draft);
    } catch (failure) {
      if (active.current) {
        const fields = failure instanceof ContractDraftSaveError ? Object.values(failure.fields) : [];
        setError([failure instanceof Error ? failure.message : "We couldn't confirm this draft.", ...fields].join(" "));
        setReloadRequired(failure instanceof ContractDraftSaveError && failure.reloadRequired);
      }
    } finally {
      pending.current = false;
      if (active.current) setConfirming(false);
      onBusy(false);
    }
  }
  return <section className="contract-confirmation" aria-label="Save to expenses">
    <h3>Save to expenses</h3>
    {issues.length ? <><p>Before confirming:</p><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></> :
      <p>Confirming creates one unpaid expense for {formatContractAmount(draft.totalAmount)} in this event using the saved details above. No payment will be recorded.</p>}
    {error && <p role="alert" className="contract-form-message">{error}</p>}
    <div className="contract-form-actions">
      {(reloadRequired || referenceIssue && !referenceIssue.startsWith("Checking")) && <Button variant="secondary" disabled={confirming} onClick={onReload}>Reload details</Button>}
      <Button disabled={confirming || reloadRequired || issues.length > 0} onClick={() => void confirm()}>{confirming ? "Confirming..." : "Confirm and create expense"}</Button>
    </div>
  </section>;
}
