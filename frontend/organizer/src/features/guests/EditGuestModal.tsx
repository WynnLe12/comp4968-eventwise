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
import { getGuestRsvpLink } from "./services/rsvpApi";
import { attendeeCount, attendeeOptions, plusOneAttendingFor } from "./guestHeadcount";

const FORM_ID = "edit-guest-form";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Matches the guest API limit for mealChoice. */
const MEAL_CHOICE_MAX_LENGTH = 200;

const rsvpOptions = RSVP_STATUSES.map((status) => ({ value: status, label: RSVP_LABELS[status] }));

/**
 * Copies this guest's private RSVP link (Feature 8), for guests without an email address
 * or to share another way. The link only works after invitations have been sent once,
 * because that sets the RSVP deadline.
 */
function RsvpLinkCopier({ eventId, guestId, disabled }: { eventId: string; guestId: string; disabled: boolean }) {
  const [state, setState] = useState<{ busy: boolean; message: string; url: string }>({ busy: false, message: "", url: "" });

  const copy = async () => {
    setState({ busy: true, message: "", url: "" });
    try {
      const url = await getGuestRsvpLink(eventId, guestId);
      try {
        await navigator.clipboard.writeText(url);
        setState({ busy: false, message: "RSVP link copied. Only share it with this guest.", url: "" });
      } catch {
        setState({ busy: false, message: "Copy this link and share it only with this guest:", url });
      }
    } catch (error) {
      setState({ busy: false, message: error instanceof Error ? error.message : "We couldn't create the link.", url: "" });
    }
  };

  return (
    <div className="rsvp-link-row">
      <Button variant="secondary" icon="link" onClick={() => void copy()} disabled={disabled || state.busy}>
        {state.busy ? "Getting link..." : "Copy RSVP link"}
      </Button>
      {state.message && <p role="status">{state.message}</p>}
      {state.url && <input readOnly value={state.url} aria-label="RSVP link" onFocus={(e) => e.target.select()} />}
    </div>
  );
}

/**
 * Name, email, RSVP status, attendees, plus-one and meal choice, pre-filled with one guest's
 * details. Saving sends a PATCH request with every field in the form. Deleting sends a
 * DELETE request after the user confirms.
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
  const [plusOneAllowed, setPlusOneAllowed] = useState(guest.plusOneAllowed);
  /** People coming: 0, 1 or 2; null while the guest hasn't answered. */
  const [attendees, setAttendees] = useState<number | null>(attendeeCount(guest));
  const [mealChoice, setMealChoice] = useState(guest.mealChoice ?? "");
  const attendeeChoices = attendeeOptions(rsvpStatus, plusOneAllowed);

  /** Keeps the attendee count valid when the status or plus-one setting changes. */
  const changeRsvp = (status: RsvpStatus, allowed: boolean) => {
    setRsvpStatus(status);
    setPlusOneAllowed(allowed);
    const options = attendeeOptions(status, allowed);
    if (!options) setAttendees(null);
    else if (attendees === null || !options.includes(attendees)) {
      // Newly accepted: start from the guest's own plus-one answer, if they gave one.
      const plusOneComing = allowed && guest.plusOneAttending === true;
      setAttendees(status === "ACCEPTED" ? (plusOneComing ? 2 : 1) : options[0]!);
    }
  };
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
      // Every field in the form is sent. The attendee count is saved as plusOneAttending,
      // which is what the Attendee(s) column and headcounts read.
      const plusOneAttending = plusOneAttendingFor(rsvpStatus, plusOneAllowed, attendees);
      await updateGuest(guestEventId, guest.guestId, {
        firstName: trimmedFirst,
        lastName: lastName.trim() || null,
        email: trimmedEmail || null,
        plusOneAllowed,
        rsvpStatus,
        mealChoice: mealChoice.trim() || null,
        ...(plusOneAttending === undefined ? {} : { plusOneAttending }),
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
        <div className="form-row">
          <SelectField
            label="RSVP status"
            options={rsvpOptions}
            value={rsvpStatus}
            onChange={(e) => {
              if (isRsvpStatus(e.target.value)) changeRsvp(e.target.value, plusOneAllowed);
            }}
          />
          <SelectField
            label="Attendee(s)"
            options={attendeeChoices
              ? attendeeChoices.map((count) => ({ value: String(count), label: String(count) }))
              : [{ value: "", label: "-" }]}
            value={attendees === null ? "" : String(attendees)}
            disabled={!attendeeChoices || attendeeChoices.length < 2}
            hint={!attendeeChoices
              ? "Set the RSVP status to Accepted or Rejected first."
              : rsvpStatus === "ACCEPTED" && !plusOneAllowed
                ? "Allow a plus-one to choose 2."
                : undefined}
            onChange={(e) => setAttendees(Number(e.target.value))}
          />
        </div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={plusOneAllowed}
            onChange={(e) => changeRsvp(rsvpStatus, e.target.checked)}
          />
          <div>
            <b>Allow a plus-one</b>
            <span>This guest can add one person when they RSVP.</span>
          </div>
        </label>
        <TextAreaField
          label="Meal choice"
          placeholder="e.g. Vegetarian"
          rows={2}
          maxLength={MEAL_CHOICE_MAX_LENGTH}
          value={mealChoice}
          onChange={(e) => setMealChoice(e.target.value)}
        />
        </fieldset>
        <RsvpLinkCopier eventId={guestEventId} guestId={guest.guestId} disabled={busy} />
      </form>
    </Modal>
  );
}
