import { useEffect, useId, useState } from "react";
import { Button, Modal } from "../../components/ui";
import { getEventTemplate, listEventTemplates } from "../../services/eventTemplates";
import type { EventTemplate, EventTemplateDetails } from "../../types/eventTemplates";
import { allocateBudget } from "./utils/budgetPreview";

/** Draft contract for Wynn's POST /events; no creation request is sent here yet. */
export interface CreateEventDraft {
  name: string;
  templateId: string;
  eventDate: string;
  venue: string;
  totalBudget: string;
}

export function CreateEventModal({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const [draft, setDraft] = useState<CreateEventDraft>({ name: "", templateId: "", eventDate: "", venue: "", totalBudget: "" });
  const [templates, setTemplates] = useState<EventTemplate[] | null>(null);
  const [listError, setListError] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const [details, setDetails] = useState<EventTemplateDetails | null>(null);
  const [detailErrorId, setDetailErrorId] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setTemplates(null);
    setListError(false);
    listEventTemplates(controller.signal).then(result => {
      if (!controller.signal.aborted) setTemplates(result);
    }).catch(() => { if (!controller.signal.aborted) setListError(true); });
    return () => controller.abort();
  }, [listAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setDetails(null);
    setDetailErrorId(null);
    if (draft.templateId) {
      getEventTemplate(draft.templateId, controller.signal).then(result => {
        if (!controller.signal.aborted) setDetails(result);
      }).catch(() => {
        if (!controller.signal.aborted) setDetailErrorId(draft.templateId);
      });
    }
    return () => controller.abort();
  }, [draft.templateId, detailAttempt]);

  const template = details?.templateId === draft.templateId ? details : null;
  const amounts = template ? allocateBudget(draft.totalBudget, template.categories) : null;
  const validDefaults = template ? allocateBudget("0", template.categories) !== null : false;
  const money = (cents: number) => (cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const update = (field: keyof CreateEventDraft, value: string) => setDraft(current => ({ ...current, [field]: value }));

  return (
    <Modal title="Create a new event" onClose={onClose} footer={
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <button className="btn btn-primary" type="submit" form={formId} disabled aria-describedby={`${formId}-status`}>Create event</button>
      </>
    }>
      <form id={formId} onSubmit={event => event.preventDefault()}>
        <label className="field"><span>Event name</span>
          <input name="name" required maxLength={150} value={draft.name} onChange={event => update("name", event.target.value)} placeholder="e.g. Birthday Dinner" />
        </label>
        <div className="form-row">
          <label className="field"><span>Event type</span>
            <select name="templateId" required value={draft.templateId} disabled={!templates?.length}
              onChange={event => update("templateId", event.target.value)}>
              <option value="">{templates === null && !listError ? "Loading event types..." : "Select event type"}</option>
              {templates?.map(item => <option key={item.templateId} value={item.templateId}>{item.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Event date</span>
            <input name="eventDate" type="date" value={draft.eventDate} onChange={event => update("eventDate", event.target.value)} />
          </label>
        </div>
        {listError && <div role="alert"><p>Couldn't load event types.</p><Button variant="secondary" onClick={() => setListAttempt(value => value + 1)}>Retry event types</Button></div>}
        {templates?.length === 0 && <p role="status">No event types available. Please try again later.</p>}
        <label className="field"><span>Venue or location</span>
          <input name="venue" maxLength={255} value={draft.venue} onChange={event => update("venue", event.target.value)} placeholder="You can add this later" />
        </label>
        <label className="field"><span>Total budget</span>
          <input name="totalBudget" inputMode="decimal" required value={draft.totalBudget}
            onChange={event => update("totalBudget", event.target.value)} placeholder="0.00" aria-describedby={`${formId}-budget-help`} />
        </label>
        <p id={`${formId}-budget-help`} className="modal-copy">Enter a non-negative amount with up to two decimal places (maximum 9,999,999,999.99).</p>
        {draft.totalBudget !== "" && allocateBudget(draft.totalBudget, [{ templateCategoryId: "validation", defaultPercentage: "100" }]) === null
          && <p role="alert">Enter a valid budget, for example 2000.00.</p>}
        <section aria-label="Budget allocation preview" aria-live="polite">
          <h3>Budget allocation preview</h3>
          {!draft.templateId ? <p>Select an event type to see its budget categories.</p>
            : detailErrorId === draft.templateId ? <div role="alert"><p>Couldn't load budget defaults.</p><Button variant="secondary" onClick={() => setDetailAttempt(value => value + 1)}>Retry budget defaults</Button></div>
            : !template ? <p role="status">Loading budget defaults...</p>
            : !validDefaults ? <p role="alert">Budget defaults are unavailable or do not total 100%. Please try another event type.</p>
            : <>
              {!amounts && <p>Enter a valid total budget to preview category amounts.</p>}
              <div className="table-wrap"><table className="template-category-table event-budget-preview">
                <thead><tr><th scope="col">Category</th><th scope="col">Allocation</th><th scope="col">Amount</th></tr></thead>
                <tbody>{template.categories.map((category, index) => <tr key={category.templateCategoryId}>
                  <td>{category.name}</td><td>{Number(category.defaultPercentage)}%</td><td>{amounts ? `$${money(amounts[index])}` : "—"}</td>
                </tr>)}</tbody>
                {amounts && <tfoot><tr><th scope="row">Total</th><td>100%</td><td>${money(amounts.reduce((sum, value) => sum + value, 0))}</td></tr></tfoot>}
              </table></div>
            </>}
        </section>
        <p id={`${formId}-status`} className="modal-copy" role="status">You can preview your budget now. Creating events is not available yet.</p>
      </form>
    </Modal>
  );
}
