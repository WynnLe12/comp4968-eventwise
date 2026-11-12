import { useEffect, useState, type FormEvent } from "react";
import { listEventTemplates } from "../../../services/eventTemplates";
import type { EventTemplate } from "../../../types/eventTemplates";
import { Button, Field, Modal } from "../../../components/ui";
import { buildEventPatch, eventEditDraft, type EventEditDraft, type OrganizerEvent } from "../services/eventApi";
import { useEditEvent, type EditEventCallbacks } from "../hooks/useEditEvent";

export function EditEventModal({ event, ...callbacks }: EditEventCallbacks & { event: OrganizerEvent }) {
  const [draft, setDraft] = useState(() => eventEditDraft(event));
  const { loading, saved, blocked, error, submit, close } = useEditEvent(event, callbacks);
  const [templates, setTemplates] = useState<EventTemplate[] | null>(null);
  const [templateError, setTemplateError] = useState(false);
  const [templateAttempt, setTemplateAttempt] = useState(0);
  useEffect(() => {
    if (event.role !== "OWNER") return;
    const controller = new AbortController();
    setTemplates(null);
    setTemplateError(false);
    listEventTemplates(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(result) || result.some((item) => !item || typeof item.templateId !== "string" || typeof item.name !== "string")) {
        throw new Error("Invalid template list");
      }
      setTemplates(result);
    }).catch(() => { if (!controller.signal.aborted) setTemplateError(true); });
    return () => controller.abort();
  }, [event.role, templateAttempt]);
  if (event.role !== "OWNER") return null;
  let changed = true;
  try { changed = Object.keys(buildEventPatch(event, draft)).length > 0; } catch { /* Show validation on Save. */ }
  const disabled = loading || saved || blocked;
  const templateChanged = draft.template_id !== (event.template_id ?? "");
  const validTemplate = !templateChanged || !draft.template_id || !!templates?.some((item) => item.templateId === draft.template_id);
  const unavailableSelection = !!draft.template_id && !templates?.some((item) => item.templateId === draft.template_id);
  const change = (field: keyof EventEditDraft, value: string) => setDraft((previous) => ({ ...previous, [field]: value }));
  const handleSubmit = (submission: FormEvent) => { submission.preventDefault(); if (validTemplate || saved) void submit(draft); };
  return (
    <Modal title="Edit event" onClose={close} footer={<>
      <Button variant="secondary" onClick={close} disabled={loading}>Cancel</Button>
      <Button type="submit" form="edit-event-form" disabled={loading || blocked || (!saved && (!changed || !validTemplate))}>
        {loading ? "Please wait..." : saved ? "Retry loading event" : "Save changes"}
      </Button>
    </>}>
      <form id="edit-event-form" onSubmit={handleSubmit} aria-busy={loading}>
        {error && <p role="alert">{error}</p>}
        <Field label="Event name" value={draft.name} onChange={(e) => change("name", e.target.value)} required disabled={disabled} />
        <div className="form-row">
          <label className="field"><span>Event type</span>
            <select name="templateId" value={draft.template_id} disabled={disabled || templates === null}
              aria-busy={templates === null && !templateError}
              onChange={(e) => change("template_id", e.target.value)}>
              <option value="">{templates === null && !templateError ? "Loading event types..." : "No event type"}</option>
              {unavailableSelection && <option value={draft.template_id} disabled>
                {templates === null && !templateError ? "Loading current event type..." : "Current event type unavailable"}
              </option>}
              {templates?.map((item) => <option key={item.templateId} value={item.templateId}>{item.name}</option>)}
            </select>
          </label>
          <Field label="Event date" type="date" min="1000-01-01" max="9999-12-31" value={draft.event_date} onChange={(e) => change("event_date", e.target.value)} disabled={disabled} />
        </div>
        {templateError && <div role="alert"><p>Couldn't load event types. Your saved event type is unchanged.</p>
          <Button variant="secondary" disabled={disabled} onClick={() => setTemplateAttempt((value) => value + 1)}>Retry event types</Button>
        </div>}
        {templates?.length === 0 && <p role="status">No event types are available. You can keep the saved type unchanged or select No event type.</p>}
        {templates !== null && unavailableSelection && <p role="status">The saved event type is unavailable. Keep it unchanged or choose another type.</p>}
        <p className="modal-copy">Changing event type does not reallocate existing budget items or change other event data.</p>
        <Field label="Venue or location" placeholder="Not set" value={draft.venue} onChange={(e) => change("venue", e.target.value)} disabled={disabled} />
        <Field label="Total budget" inputMode="decimal" value={draft.total_budget} onChange={(e) => change("total_budget", e.target.value)} required disabled={disabled} />
      </form>
    </Modal>
  );
}
