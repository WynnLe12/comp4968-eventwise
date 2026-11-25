import { useState, type FormEvent } from "react";
import { Field, Icon, SelectField, TextAreaField } from "../../components/ui";
import type { Task, TaskFieldErrors } from "../../types";
import { draftErrors, draftOf, type TaskDraft } from "./taskRules";

/** What the page returns when a save fails: the banner message, plus inline messages by field. */
export interface TaskFormSubmitError {
  message: string;
  fields?: TaskFieldErrors;
}

export interface AssigneeOption {
  memberId: string;
  label: string;
}

/**
 * Add / edit form. The Modal footer's submit button targets it through `formId`.
 * Shows the API's `error.fields` messages under each field, like VendorForm.
 */
export function TaskForm({
  formId,
  task,
  assignees,
  onSubmit,
}: {
  formId: string;
  task: Task | null;
  assignees: AssigneeOption[];
  onSubmit: (draft: TaskDraft) => Promise<TaskFormSubmitError | null>;
}) {
  const [values, setValues] = useState<TaskDraft>(() => draftOf(task));
  const [errors, setErrors] = useState<TaskFieldErrors>({});
  const [banner, setBanner] = useState("");

  const set = (field: keyof TaskDraft) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  // Keep the current assignee selectable even if the member list failed to load.
  const options = [
    { value: "", label: "Unassigned" },
    ...assignees.map((a) => ({ value: a.memberId, label: a.label })),
    ...(task?.assignee && !assignees.some((a) => a.memberId === task.assignee!.memberId)
      ? [{ value: task.assignee.memberId, label: task.assignee.displayName ?? "Current assignee" }]
      : []),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local = draftErrors(values);
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }
    setBanner("");
    const failure = await onSubmit(values);
    if (failure) {
      setBanner(failure.fields && Object.keys(failure.fields).length ? "" : failure.message);
      setErrors(failure.fields ?? {});
    }
  };

  return (
    <form id={formId} onSubmit={submit} noValidate className="task-form">
      {banner && (
        <div className="form-error-banner" role="alert">
          <Icon name="alert" size={17} />
          <span>{banner}</span>
        </div>
      )}
      <Field
        label="Task"
        value={values.title}
        maxLength={200}
        required
        placeholder="e.g. Book ceremony musicians"
        error={errors.title}
        onChange={(e) => set("title")(e.target.value)}
      />
      <TextAreaField
        label="Notes"
        value={values.description}
        maxLength={2000}
        rows={3}
        placeholder="Optional details"
        error={errors.description}
        onChange={(e) => set("description")(e.target.value)}
      />
      <div className="form-row">
        <Field
          label="Due date"
          type="date"
          value={values.dueDate}
          error={errors.dueDate}
          onChange={(e) => set("dueDate")(e.target.value)}
        />
        <SelectField
          label="Assigned to"
          value={values.assignedMemberId}
          options={options}
          error={errors.assignedMemberId}
          onChange={(e) => set("assignedMemberId")(e.target.value)}
        />
      </div>
      {errors.isCompleted && <p className="field-error">{errors.isCompleted}</p>}
    </form>
  );
}
