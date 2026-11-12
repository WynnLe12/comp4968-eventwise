import { useState, type FormEvent } from "react";
import { Button, Field, Icon, Modal } from "../../../components/ui";
import { useCreateEvent, type CreateEventCallbacks } from "../hooks/useCreateEvent";

export function CreateEventModal(callbacks: CreateEventCallbacks) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [date, setDate] = useState("");
  const [venue, setVenue] = useState("");
  const [budget, setBudget] = useState("");
  const [useTemplate, setUseTemplate] = useState(false);
  const { loading, created, error, submit, close } = useCreateEvent(callbacks);
  const disabled = loading || created;
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit({
      name, template_id: useTemplate ? template.trim() : null,
      event_date: date || null, venue: venue.trim() || null,
      ...(budget.trim() ? { total_budget: budget.trim() } : {}),
    });
  };
  return (
    <Modal title="Create a new event" onClose={close} footer={
      <>
        <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
        <Button type="submit" form="create-event-form" disabled={loading}>{loading ? "Please wait..." : created ? "Retry loading event" : "Create event"}</Button>
      </>
    }>
      <form id="create-event-form" onSubmit={handleSubmit} aria-busy={loading}>
        {error && <p role="alert">{error}</p>}
        <Field label="Event name" placeholder="Event name" value={name} onChange={(e) => setName(e.target.value)} required disabled={disabled} />
        <div className="form-row">
          <Field label="Event type (template ID)" placeholder="Optional existing template ID" inputMode="numeric" value={template} onChange={(e) => setTemplate(e.target.value)} required={useTemplate && !created} disabled={disabled || !useTemplate} />
          <Field label="Event date" type="date" min="1000-01-01" max="9999-12-31" value={date} onChange={(e) => setDate(e.target.value)} disabled={disabled} />
        </div>
        <Field label="Venue or location" placeholder="You can add this later" value={venue} onChange={(e) => setVenue(e.target.value)} disabled={disabled} />
        <Field label="Total budget" placeholder="0.00" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={disabled} />
        <label className="template-choice">
          <Icon name="spark" />
          <div><b>Start with a smart template</b><span>Use an existing template ID above, or leave this unchecked to start without a template.</span></div>
          <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} disabled={disabled} />
        </label>
      </form>
    </Modal>
  );
}
