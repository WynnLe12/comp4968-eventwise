import { useState, type FormEvent } from "react";
import { Button, Field, Modal, SelectField, TextAreaField } from "../../components/ui";
import {
  deleteGuest,
  GuestApiError,
  isRsvpStatus,
  RSVP_LABELS,
  RSVP_STATUSES,
  updateGuest,
  type GuestRecord,
  type RsvpStatus,
} from "./services/guestApi";

const FORM_ID = "edit-guest-form";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Matches the guest API limit for mealChoice. */
const MEAL_CHOICE_MAX_LENGTH = 50;

const rsvpOptions = RSVP_STATUSES.map((status) => ({ value: status, label: RSVP_LABELS[status] }));

/**
 * Name, email, RSVP status and meal choice, pre-filled with one guest's details.
 * Saving sends a PATCH request with every field in the form (plus the guest's current
 * plusOneAllowed). Deleting sends a DELETE request after the user confirms.
 */
export function EditGuestModal({
  guest,
  eventId,
  onClose,
  onSaved,
  onDeleted,
}: {
  guest: GuestRecord;
  /** The selected event; used if the guest record has no eventId. */
  eventId: string;
  onClose: () => void;
  /** Called after the API saves the changes, with the guest's updated name. */
  onSaved: (name: string) => void;
  /** Called after the API deletes the guest, with the name shown in the form. */
  onDeleted: (name: string) => void;
}) {
  const [firstName, setFirstName] = useState(guest.firstName ?? "");
  const [lastName, setLastName] = useState(guest.lastName ?? "");
  const [email, setEmail] = useState(guest.email ?? "");
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus>(guest.rsvpStatus);
  const [mealChoice, setMealChoice] = useState(guest.mealChoice ?? "");
  const [firstNameError, setFirstNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Error from the last save or delete request. */
  const [formError, setFormError] = useState("");
  const busy = saving || deleting;
  const guestEventId = guest.eventId || eventId;

  const displayName =
    [guest.firstName, guest.lastName].filter(Boolean).join(" ") || guest.email || "this guest";

  const confirmDelete = async () => {
    if (busy) return;
    setDeleting(true);
    setFormError("");
    try {
      await deleteGuest(guestEventId, guest.guestId);
      onDeleted(displayName);
    } catch (reason) {
      setFormError(
        reason instanceof GuestApiError ? reason.message : "Unable to delete this guest. Please try again.",
      );
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmedFirst = firstName.trim();
    const trimmedEmail = email.trim();
    const firstError = trimmedFirst ? "" : "Enter a first name.";
    const mailError =
      trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail) ? "Enter a valid email address." : "";
    setFirstNameError(firstError);
    setEmailError(mailError);
    if (firstError || mailError) return;

    setSaving(true);
    setFormError("");
    try {
      // Every field in the form is sent; plusOneAllowed keeps the guest's current value.
      await updateGuest(guestEventId, guest.guestId, {
        firstName: trimmedFirst,
        lastName: lastName.trim() || null,
        email: trimmedEmail || null,
        plusOneAllowed: guest.plusOneAllowed,
        rsvpStatus,
        mealChoice: mealChoice.trim() || null,
      });
      onSaved([trimmedFirst, lastName.trim()].filter(Boolean).join(" "));
    } catch (reason) {
      setFormError(
        reason instanceof GuestApiError ? reason.message : "Unable to save this guest. Please try again.",
      );
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Edit guest"
      onClose={busy ? () => undefined : onClose}
      footer={
        confirmingDelete ? (
          <>
            <span className="guest-footer-start guest-delete-prompt" role="alert">
              Delete {displayName}? This can't be undone.
            </span>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Keep guest
            </Button>
            <Button variant="danger" icon="trash" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete guest"}
            </Button>
          </>
        ) : (
          <>
            <span className="guest-footer-start">
              <Button
                variant="danger"
                icon="trash"
                disabled={busy}
                onClick={() => {
                  setFormError("");
                  setConfirmingDelete(true);
                }}
              >
                Delete
              </Button>
            </span>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} disabled={busy}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </>
        )
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate>
        {formError && (
          <p className="guest-form-error" role="alert">
            {formError}
          </p>
        )}
        <fieldset className="guest-form-fieldset" disabled={busy}>
        <div className="form-row">
          <Field
            label="First name"
            placeholder="First name"
            value={firstName}
            error={firstNameError}
            onChange={(e) => {
              setFirstName(e.target.value);
              if (firstNameError) setFirstNameError("");
            }}
          />
          <Field
            label="Last name"
            placeholder="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <div className="form-row">
          <Field
            label="Email"
            type="email"
            placeholder="guest@example.com"
            value={email}
            error={emailError}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError("");
            }}
          />
          <SelectField
            label="RSVP status"
            options={rsvpOptions}
            value={rsvpStatus}
            onChange={(e) => {
              if (isRsvpStatus(e.target.value)) setRsvpStatus(e.target.value);
            }}
          />
        </div>
        <TextAreaField
          label="Meal choice"
          placeholder="e.g. Vegetarian"
          rows={2}
          maxLength={MEAL_CHOICE_MAX_LENGTH}
          value={mealChoice}
          onChange={(e) => setMealChoice(e.target.value)}
        />
        </fieldset>
      </form>
    </Modal>
  );
}
