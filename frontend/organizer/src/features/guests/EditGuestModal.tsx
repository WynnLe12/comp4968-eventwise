import { useState, type FormEvent } from "react";
import { Button, Field, Modal, SelectField, TextAreaField } from "../../components/ui";
import {
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
 */
export function EditGuestModal({
  guest,
  onClose,
  onSave,
}: {
  guest: GuestRecord;
  onClose: () => void;
  onSave: (guest: GuestRecord) => void;
}) {
  const [firstName, setFirstName] = useState(guest.firstName ?? "");
  const [lastName, setLastName] = useState(guest.lastName ?? "");
  const [email, setEmail] = useState(guest.email ?? "");
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus>(guest.rsvpStatus);
  const [mealChoice, setMealChoice] = useState(guest.mealChoice ?? "");
  const [firstNameError, setFirstNameError] = useState("");

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
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <button type="submit" form={FORM_ID} className="btn btn-primary">
            Save changes
          </button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate>
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
