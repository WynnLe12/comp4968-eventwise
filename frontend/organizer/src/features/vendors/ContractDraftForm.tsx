import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Field, SelectField } from "../../components/ui";
import { useResource } from "../../hooks/useResource";
import { useEvents } from "../events/EventsContext";
import { useEventCategories } from "../categories/useEventCategories";
import { vendorService } from "../../services/vendorService";
import { ContractDraftSaveError, saveContractDraft, type ContractDraftDetails } from "./contractsApi";
import { contractDraftFormValues, prepareContractDraftChanges, type ContractDraftFormErrors, type ContractDraftFormValues } from "./contractDraftValidation";

export function ContractDraftForm({ draft, onSaved, onCancel, onReload, onBusy }: {
  draft: ContractDraftDetails; onSaved: (draft: ContractDraftDetails) => void;
  onCancel: () => void; onReload: () => void; onBusy: (busy: boolean) => void;
}) {
  const { userId } = useEvents();
  const categories = useEventCategories(draft.eventId, userId ?? "");
  const loadVendors = useCallback(() => vendorService.list(draft.eventId), [draft.eventId]);
  const vendors = useResource(loadVendors);
  const [values, setValues] = useState(() => contractDraftFormValues(draft));
  const [errors, setErrors] = useState<ContractDraftFormErrors>({});
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function update(field: keyof ContractDraftFormValues, value: string) {
    if (pending.current || conflict) return;
    setValues(current => ({ ...current, [field]: value }));
    setErrors(current => ({ ...current, [field]: undefined }));
    setMessage("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || conflict || draft.status !== "DRAFT") return;
    const prepared = prepareContractDraftChanges(values, draft);
    const fields = prepared.errors;
    if (values.categoryId && (categories.loading || categories.error || !categories.categories.some(row => row.categoryId === values.categoryId))) fields.categoryId = "Load and choose a category from this event.";
    if (values.vendorId && (vendors.loading || vendors.error || !vendors.data?.some(row => row.id === values.vendorId && row.eventId === draft.eventId))) fields.vendorId = "Load and choose a vendor from this event.";
    setErrors(fields);
    if (Object.values(fields).some(Boolean)) {
      setMessage("Please check the highlighted details and try again.");
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    if (Object.keys(prepared.changes).length === 0) { setMessage("No changes to save."); return; }
    pending.current = true; setSaving(true); onBusy(true); setMessage("");
    try {
      const saved = await saveContractDraft(draft.eventId, draft.draftId, draft.version, prepared.changes);
      if (active.current) onSaved(saved);
    } catch (error) {
      if (active.current) {
        setMessage(error instanceof Error ? error.message : "We couldn't save this draft. Please try again.");
        if (error instanceof ContractDraftSaveError) { setErrors(error.fields); setConflict(error.reloadRequired); }
      }
    } finally {
      pending.current = false;
      if (active.current) setSaving(false);
      onBusy(false);
    }
  }
  const categoryOptions = [{ value: "", label: categories.loading ? "Loading categories..." : "Not selected yet" },
    ...(values.categoryId && !categories.categories.some(row => row.categoryId === values.categoryId) ? [{ value: values.categoryId, label: "Current category unavailable", disabled: true }] : []),
    ...categories.categories.map(row => ({ value: row.categoryId, label: row.name }))];
  const vendorOptions = [{ value: "", label: vendors.loading ? "Loading vendors..." : "No vendor linked" },
    ...(values.vendorId && !vendors.data?.some(row => row.id === values.vendorId) ? [{ value: values.vendorId, label: "Current vendor unavailable", disabled: true }] : []),
    ...(vendors.data ?? []).map(row => ({ value: row.id, label: row.name }))];
  return <form ref={formRef} className="contract-draft-form" noValidate onSubmit={event => void submit(event)}>
    <p>You can save an incomplete draft and finish reviewing it later. Saving does not create an expense.</p>
    {message && <p role="alert" className="contract-form-message">{message}</p>}
    {conflict && <Button variant="secondary" onClick={onReload}>Reload latest draft (discard edits)</Button>}
    <fieldset disabled={saving || conflict}>
      <Field label="Expense name" value={values.description} maxLength={255} error={errors.description} onChange={event => update("description", event.target.value)} />
      <SelectField label="Category" value={values.categoryId} options={categoryOptions} disabled={categories.loading || Boolean(categories.error)} error={errors.categoryId} onChange={event => update("categoryId", event.target.value)} />
      {categories.error && <p role="alert">{categories.error} <Button variant="ghost" onClick={categories.retry}>Retry categories</Button></p>}
      {!categories.loading && !categories.error && !categories.categories.length && <p>Add categories in <Link to="/app/budget">Budget</Link> before confirming an expense.</p>}
      <SelectField label="Vendor (optional)" value={values.vendorId} options={vendorOptions} disabled={vendors.loading || Boolean(vendors.error)} error={errors.vendorId} onChange={event => update("vendorId", event.target.value)} />
      {Boolean(vendors.error) && <p role="alert">Couldn't load vendors. <Button variant="ghost" onClick={vendors.reload}>Retry vendors</Button></p>}
      {!values.vendorId && <Field label="Vendor name from document (optional)" value={values.vendorName} maxLength={150} error={errors.vendorName} hint="This name alone does not create or link a vendor." onChange={event => update("vendorName", event.target.value)} />}
      <div>
        <Field label="Total amount" inputMode="decimal" placeholder="0.00" value={values.totalAmount} error={errors.totalAmount} onChange={event => update("totalAmount", event.target.value)} />
      </div>
      <div className="form-row">
        <Field label="Deposit required (optional)" inputMode="decimal" placeholder="0.00" value={values.depositAmount} error={errors.depositAmount} hint="A requirement, not a recorded payment." onChange={event => update("depositAmount", event.target.value)} />
        <Field label="Due date (optional)" type="date" min="1000-01-01" max="9999-12-31" value={values.dueDate} error={errors.dueDate} onChange={event => update("dueDate", event.target.value)} />
      </div>
    </fieldset>
    <div className="contract-form-actions">
      <Button variant="secondary" disabled={saving} onClick={onCancel}>Cancel editing</Button>
      <Button type="submit" disabled={saving || conflict}>{saving ? "Saving..." : "Save draft"}</Button>
    </div>
  </form>;
}
