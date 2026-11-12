import { useState, type FormEvent } from "react";
import { Button, Field, Modal } from "../../../components/ui";
import { buildEventPatch, eventEditDraft, type EventEditDraft, type OrganizerEvent } from "../services/eventApi";
import { useEditEvent, type EditEventCallbacks } from "../hooks/useEditEvent";

export function EditEventModal({ event, ...callbacks }: EditEventCallbacks & { event: OrganizerEvent }) {
  const [draft, setDraft] = useState(() => eventEditDraft(event));
  const { loading, saved, blocked, error, submit, close } = useEditEvent(event, callbacks);
  if (event.role !== "OWNER") return null;
  let changed = true;
  try { changed = Object.keys(buildEventPatch(event, draft)).length > 0; } catch { /* Show validation on Save. */ }
  const disabled = loading || saved || blocked;
  const change = (field: keyof EventEditDraft, value: string) => setDraft((previous) => ({ ...previous, [field]: value }));
  const handleSubmit = (submission: FormEvent) => { submission.preventDefault(); void submit(draft); };
  return (
    <Modal title="Edit event" onClose={close} footer={<>
      <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
      <Button type="submit" form="edit-event-form" disabled={loading || blocked || (!changed && !saved)}>
        {loading ? "Please wait..." : saved ? "Retry loading event" : "Save changes"}
      </Button>
    </>}>
      <form id="edit-event-form" onSubmit={handleSubmit} aria-busy={loading}>
        {error && <p role="alert">{error}</p>}
        <Field label="Event name" value={draft.name} onChange={(e) => change("name", e.target.value)} required disabled={disabled} />
        <div className="form-row">
          <Field label="Event type (template ID)" placeholder="No template" inputMode="numeric" value={draft.template_id} onChange={(e) => change("template_id", e.target.value)} disabled={disabled} />
          <Field label="Event date" type="date" min="1000-01-01" max="9999-12-31" value={draft.event_date} onChange={(e) => change("event_date", e.target.value)} disabled={disabled} />
        </div>
        <Field label="Venue or location" placeholder="Not set" value={draft.venue} onChange={(e) => change("venue", e.target.value)} disabled={disabled} />
        <Field label="Total budget" inputMode="decimal" value={draft.total_budget} onChange={(e) => change("total_budget", e.target.value)} required disabled={disabled} />
      </form>
    </Modal>
  );
}
