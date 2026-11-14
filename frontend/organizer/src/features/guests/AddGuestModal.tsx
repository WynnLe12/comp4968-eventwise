import { useState, type FormEvent } from "react";
import { Button, Field, Modal } from "../../components/ui";
import { createGuest, GuestApiError } from "./services/guestApi";

const FORM_ID = "add-guest-form";
// Limits from the guest API contract (docs/api/guests.md).
const NAME_MAX = 100;
const EMAIL_MAX = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  firstName?: string;
  email?: string;
}

/** "Add a guest" form. Saving sends a PUT request to the guest API for the given event. */
export function AddGuestModal({
  eventId,
  onClose,
  onAdded,
}: {
  eventId: string;
  onClose: () => void;
  /** Called after the API accepts the new guest. */
  onAdded: (name: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [plusOneAllowed, setPlusOneAllowed] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!firstName.trim()) next.firstName = "Enter a first name.";
    const trimmedEmail = email.trim();
    if (trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail)) next.email = "Enter a valid email address.";
    return next;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setSaveError("");
    try {
      await createGuest(eventId, {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        plusOneAllowed,
      });
      onAdded([firstName.trim(), lastName.trim()].filter(Boolean).join(" "));
    } catch (reason) {
      setSaveError(
        reason instanceof GuestApiError ? reason.message : "Unable to add this guest. Please try again.",
      );
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add a guest"
      onClose={saving ? () => undefined : onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate>
        {saveError && (
          <p className="guest-form-error" role="alert">
            {saveError}
          </p>
        )}
        <fieldset className="guest-form-fieldset" disabled={saving}>
          <div className="form-row">
            <Field
              label="First name"
              placeholder="First name"
              maxLength={NAME_MAX}
              value={firstName}
              error={errors.firstName}
              onChange={(e) => {
                setFirstName(e.target.value);
                if (errors.firstName) setErrors({ ...errors, firstName: undefined });
              }}
            />
            <Field
              label="Last name"
              placeholder="Last name"
              maxLength={NAME_MAX}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
          <Field
            label="Email"
            type="email"
            placeholder="guest@example.com"
            maxLength={EMAIL_MAX}
            value={email}
            error={errors.email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.email) setErrors({ ...errors, email: undefined });
            }}
          />
          <label className="check-field">
            <input
              type="checkbox"
              checked={plusOneAllowed}
              onChange={(e) => setPlusOneAllowed(e.target.checked)}
            />
            <div>
              <b>Allow a plus-one</b>
              <span>This guest can add one person when they RSVP.</span>
            </div>
          </label>
        </fieldset>
      </form>
    </Modal>
  );
}
