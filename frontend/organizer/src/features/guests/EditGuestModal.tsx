import { useState, type FormEvent } from "react";
import { Button, Field, Modal, SelectField, TextAreaField } from "../../components/ui";
import {
  deleteGuest,
  GuestApiError,
  isRsvpStatus,
  RSVP_LABELS,
  RSVP_STATUSES,
  type GuestRecord,
  type RsvpStatus,
} from "./services/guestApi";

const FORM_ID = "edit-guest-form";
/** Matches the guest API limit for mealChoice. */
const MEAL_CHOICE_MAX_LENGTH = 50;

const rsvpOptions = RSVP_STATUSES.map((status) => ({ value: status, label: RSVP_LABELS[status] }));

/**
 * Name, email, RSVP status and meal choice, pre-filled with one guest's details.
 * Fields not shown here (such as plusOneAllowed) are kept as they are.
 * Saving only updates the list on this page; nothing is sent to the guest API yet.
 * Deleting sends a DELETE request to the guest API after the user confirms.
 */
export function EditGuestModal({
  guest,
  eventId,
  onClose,
  onSave,
  onDeleted,
}: {
  guest: GuestRecord;
  /** The selected event; used if the guest record has no eventId. */
  eventId: string;
  onClose: () => void;
  onSave: (guest: GuestRecord) => void;
  /** Called after the API deletes the guest, with the name shown in the form. */
  onDeleted: (name: string) => void;
}) {
  const [firstName, setFirstName] = useState(guest.firstName ?? "");
  const [lastName, setLastName] = useState(guest.lastName ?? "");
  const [email, setEmail] = useState(guest.email ?? "");
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus>(guest.rsvpStatus);
  const [mealChoice, setMealChoice] = useState(guest.mealChoice ?? "");
  const [firstNameError, setFirstNameError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const displayName =
    [guest.firstName, guest.lastName].filter(Boolean).join(" ") || guest.email || "this guest";

  const confirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteGuest(guest.eventId || eventId, guest.guestId);
      onDeleted(displayName);
    } catch (reason) {
      setDeleteError(
        reason instanceof GuestApiError ? reason.message : "Unable to delete this guest. Please try again.",
      );
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!firstName.trim()) {
      setFirstNameError("Enter a first name.");
      return;
    }
    onSave({
      ...guest,
      firstName: firstName.trim(),
      lastName: lastName.trim() || null,
      email: email.trim() || null,
      rsvpStatus,
      mealChoice: mealChoice.trim() || null,
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <Modal
      title="Edit guest"
      onClose={deleting ? () => undefined : onClose}
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
                onClick={() => {
                  setDeleteError("");
                  setConfirmingDelete(true);
                }}
              >
                Delete
              </Button>
            </span>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <button type="submit" form={FORM_ID} className="btn btn-primary">
              Save changes
            </button>
          </>
        )
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate>
        {deleteError && (
          <p className="guest-form-error" role="alert">
            {deleteError}
          </p>
        )}
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
            onChange={(e) => setEmail(e.target.value)}
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
      </form>
    </Modal>
  );
}
