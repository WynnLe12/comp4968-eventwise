import { useEffect, useState } from "react";
import { useCreateEvent, type CreateEventCallbacks } from "../hooks/useCreateEvent";
import { Button, Field, Modal } from "../../../components/ui";
import { getEventTemplate, listEventTemplates } from "../../../services/eventTemplates";
import type { EventTemplate, EventTemplateDetails } from "../../../types/eventTemplates";
import { allocateBudget } from "../utils/budgetPreview";
import { localToday, validateEventForm, type EventFormValues } from "../utils/eventFormValidation";
import { useEventValidation } from "../hooks/useEventValidation";
import "../eventForms.css";

/** Controlled template-form fields; event persistence uses the existing event API. */
export interface CreateEventDraft {
  name: string;
  templateId: string;
  eventDate: string;
  venue: string;
  totalBudget: string;
}

export function createEventInputFromDraft(draft: CreateEventDraft) {
  return { name: draft.name, template_id: draft.templateId || null,
    event_date: draft.eventDate || null, venue: draft.venue.trim() || null,
    total_budget: draft.totalBudget.trim() };
}

export function CreateEventModal(callbacks: CreateEventCallbacks) {
  const formId = "create-event-form";
  const emptyDraft = (): CreateEventDraft => ({ name: "", templateId: "", eventDate: "", venue: "", totalBudget: "" });
  const [draft, setDraft] = useState<CreateEventDraft>(emptyDraft);
  const [templates, setTemplates] = useState<EventTemplate[] | null>(null);
  const [listError, setListError] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const [details, setDetails] = useState<EventTemplateDetails | null>(null);
  const [detailErrorId, setDetailErrorId] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const values = (value: CreateEventDraft): EventFormValues => ({ name: value.name, template_id: value.templateId, event_date: value.eventDate, venue: value.venue, total_budget: value.totalBudget });
  const validation = useEventValidation((value) => validateEventForm(value, true));
  const { errors } = validation;
  const reset = () => { setDraft(emptyDraft()); validation.reset(); setDetails(null); setDetailErrorId(null); };
  const { loading, created, error, submit, close } = useCreateEvent({ ...callbacks,
    onClose: () => { reset(); callbacks.onClose(); },
    onComplete: () => { reset(); callbacks.onComplete(); },
  });

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
  const keys = { name: "name", templateId: "template_id", eventDate: "event_date", venue: "venue", totalBudget: "total_budget" } as const;
  const update = (field: keyof CreateEventDraft, value: string) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    validation.change(keys[field], values(next));
  };

  const canSubmit = !!templates?.some(item => item.templateId === draft.templateId) && validDefaults && amounts !== null;

  return (
    <Modal title="Create a new event" onClose={close} footer={
      <>
        <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
        <Button type="submit" form={formId} disabled={loading}>{loading ? "Please wait..." : created ? "Retry loading event" : "Create event"}</Button>
      </>
    }>
      <form id={formId} noValidate className="event-form" aria-busy={loading} onSubmit={async event => {
        event.preventDefault();
        if (loading || (!created && !validation.check(values(draft)))) return;
        if (created || canSubmit) {
          const fields = await submit(createEventInputFromDraft(draft));
          if (fields) validation.serverErrors(fields);
        }
      }}>
        {validation.showSummary && <p className="expense-form-error" role="alert">Please fix the highlighted fields and try again.</p>}
        {error && <p role="alert">{error}</p>}
        <fieldset disabled={loading || created} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <Field label="Event name *" name="name" required value={draft.name} error={errors.name}
          onChange={event => update("name", event.target.value)} onBlur={() => validation.blur("name", values(draft))} placeholder="e.g. Birthday Dinner" />
        <div className="form-row">
          <label className="field"><span>Event type *</span>
            <select name="templateId" required value={draft.templateId} disabled={!templates?.length}
              onChange={event => update("templateId", event.target.value)} onBlur={() => validation.blur("template_id", values(draft))}
              aria-invalid={Boolean(errors.template_id)} aria-describedby={errors.template_id ? "create-type-error" : undefined}>
              <option value="">{templates === null && !listError ? "Loading event types..." : "Select event type"}</option>
              {templates?.map(item => <option key={item.templateId} value={item.templateId}>{item.name}</option>)}
            </select>
            {errors.template_id && <small id="create-type-error" className="expense-field-error">{errors.template_id}</small>}
          </label>
          <Field label="Event date *" name="eventDate" type="date" required min={localToday()} max="9999-12-31" value={draft.eventDate} error={errors.event_date}
            onChange={event => update("eventDate", event.target.value)} onBlur={() => validation.blur("event_date", values(draft))} />
        </div>
        {listError && <div role="alert"><p>Couldn't load event types.</p><Button variant="secondary" onClick={() => setListAttempt(value => value + 1)}>Retry event types</Button></div>}
        {templates?.length === 0 && <p role="status">No event types available. Please try again later.</p>}
        <Field label="Venue or location (optional)" name="venue" value={draft.venue} error={errors.venue}
          onChange={event => update("venue", event.target.value)} onBlur={() => validation.blur("venue", values(draft))} placeholder="You can add this later" />
        <Field label="Total budget *" name="totalBudget" inputMode="decimal" required value={draft.totalBudget} error={errors.total_budget}
          onChange={event => update("totalBudget", event.target.value)} onBlur={() => validation.blur("total_budget", values(draft))} placeholder="0.00" />
        <section aria-label="Budget allocation preview" aria-live="polite">
          {!draft.templateId ? <p className="modal-copy">Select an event type to see its budget categories.</p>
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
        </fieldset>
      </form>
    </Modal>
  );
}
