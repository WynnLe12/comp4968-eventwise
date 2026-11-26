// Public RSVP page (Feature 8), opened from the private link in a guest's invitation email.
// No sign-in: the token in the URL identifies one guest of one event and is the only
// credential. Guests can change their answer until the deadline.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button, Icon } from "../../components/ui";
import {
  fetchGuestRsvp,
  formatEventDate,
  formatInstant,
  formatStartTime,
  RsvpApiError,
  submitGuestRsvp,
  type GuestRsvp as GuestRsvpData,
} from "./services/rsvpApi";
import "./rsvp.css";

const MEAL_MAX = 50;
const NOTES_MAX = 500;

type Choice = "yes" | "no" | "";

interface Draft {
  attending: Choice;
  mealChoice: string;
  dietaryNotes: string;
  plusOne: Choice;
}

function draftFrom(data: GuestRsvpData): Draft {
  const { guest } = data;
  const answered = guest.rsvpStatus === "ACCEPTED" || guest.rsvpStatus === "REJECTED";
  return {
    attending: !answered ? "" : guest.rsvpStatus === "ACCEPTED" ? "yes" : "no",
    mealChoice: guest.mealChoice ?? "",
    dietaryNotes: guest.dietaryNotes ?? "",
    plusOne: guest.plusOneAttending === null ? "" : guest.plusOneAttending ? "yes" : "no",
  };
}

export function GuestRsvp() {
  const { token = "" } = useParams<{ token: string }>();
  return <RsvpPage key={token} token={token} />;
}

function RsvpPage({ token }: { token: string }) {
  const [data, setData] = useState<GuestRsvpData | null>(null);
  const [error, setError] = useState<RsvpApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      setData(await fetchGuestRsvp(token, signal));
      setError(null);
    } catch (caught) {
      if (signal.aborted) return;
      setError(caught instanceof RsvpApiError ? caught : new RsvpApiError("Something went wrong.", 0, "ERROR"));
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  useEffect(() => {
    document.title = data ? `RSVP · ${data.event.eventName}` : "RSVP";
  }, [data]);

  if (error?.status === 404) {
    return (
      <main className="guest-rsvp">
        <div className="rsvp-card rsvp-message" role="alert">
          <Icon name="link" />
          <h1>This link doesn't work</h1>
          <p>{error.message}</p>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="guest-rsvp">
        <div className="rsvp-card rsvp-message" role={error ? "alert" : "status"}>
          {error ? (
            <>
              <h1>We couldn't load your invitation</h1>
              <p>{error.message}</p>
              <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            </>
          ) : (
            <p>Loading your invitation…</p>
          )}
        </div>
      </main>
    );
  }
  return <RsvpForm token={token} data={data} onSaved={setData} />;
}

function RsvpForm({ token, data, onSaved }: { token: string; data: GuestRsvpData; onSaved: (data: GuestRsvpData) => void }) {
  const { event, guest } = data;
  const answered = guest.rsvpStatus === "ACCEPTED" || guest.rsvpStatus === "REJECTED";
  const [editing, setEditing] = useState(!answered && !data.closed);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(data));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const update = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: "" } : current));
  };

  const submit = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (saving) return;
    const found: Record<string, string> = {};
    if (!draft.attending) found.attending = "Let the hosts know whether you're coming.";
    if (draft.attending === "yes" && guest.plusOneAllowed && !draft.plusOne) found.plusOne = "Let the hosts know whether your plus-one is coming.";
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setFormError("");
    try {
      const attending = draft.attending === "yes";
      const saved = await submitGuestRsvp(token, {
        attending,
        mealChoice: attending ? draft.mealChoice.trim() || null : null,
        dietaryNotes: attending ? draft.dietaryNotes.trim() || null : null,
        plusOneAttending: attending && guest.plusOneAllowed && draft.plusOne === "yes",
      });
      onSaved(saved);
      setDraft(draftFrom(saved));
      setEditing(false);
      setJustSaved(true);
    } catch (caught) {
      if (caught instanceof RsvpApiError && caught.code === "RSVP_CLOSED") {
        setFormError("Sorry, RSVPs for this event closed before your answer arrived. Please contact the hosts.");
      } else if (caught instanceof RsvpApiError && Object.keys(caught.fields).length) {
        setErrors({ ...caught.fields, ...(caught.fields.plusOneAttending ? { plusOne: caught.fields.plusOneAttending } : {}) });
        setFormError(caught.message);
      } else {
        setFormError(caught instanceof Error ? caught.message : "We couldn't send your RSVP. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const name = guest.firstName ?? "there";
  const when = event.eventDate
    ? `${formatEventDate(event.eventDate)}${event.startTime ? ` at ${formatStartTime(event.startTime)}` : ""}`
    : event.startTime ? `Starts at ${formatStartTime(event.startTime)}` : "Date to be announced";

  return (
    <main className="guest-rsvp">
      <article className="rsvp-card">
        <header className="rsvp-header">
          <p className="rsvp-eyebrow">You're invited</p>
          <h1>{event.eventName}</h1>
          <ul className="rsvp-details">
            <li><Icon name="calendar" size={16} /><span>{when}</span></li>
            {event.venue && <li><Icon name="store" size={16} /><span>{event.venue}</span></li>}
          </ul>
          {data.message && <p className="rsvp-note">{data.message}</p>}
        </header>

        {data.closed ? (
          <p className="rsvp-banner closed" role="status">
            RSVPs closed on {formatInstant(data.deadline)}.
            {answered ? " Here's the answer the hosts have." : " Please contact the hosts if you'd still like to reply."}
          </p>
        ) : (
          <p className="rsvp-banner">Please reply by <b>{formatInstant(data.deadline)}</b>.</p>
        )}

        {justSaved && !editing && (
          <p className="rsvp-saved" role="status">
            <Icon name="check" size={16} /> Thanks, {name}! The hosts have your RSVP.
          </p>
        )}

        {!editing ? (
          answered && (
            <section className="rsvp-summary" aria-label="Your RSVP">
              <h2>{guest.rsvpStatus === "ACCEPTED" ? "You're coming 🎉" : "You can't make it"}</h2>
              {guest.rsvpStatus === "ACCEPTED" && (
                <dl>
                  <div><dt>Meal preference</dt><dd>{guest.mealChoice ?? "No preference"}</dd></div>
                  <div><dt>Allergies or dietary needs</dt><dd>{guest.dietaryNotes ?? "None"}</dd></div>
                  {guest.plusOneAllowed && <div><dt>Plus-one</dt><dd>{guest.plusOneAttending ? "Coming" : "Not coming"}</dd></div>}
                </dl>
              )}
              {!data.closed && (
                <Button variant="secondary" onClick={() => { setEditing(true); setJustSaved(false); }}>Change my response</Button>
              )}
            </section>
          )
        ) : (
          <form className="rsvp-guest-form" onSubmit={submit} noValidate>
            <h2>Hi {name}, will you be joining us?</h2>
            {formError && <p className="rsvp-error" role="alert">{formError}</p>}
            <fieldset disabled={saving}>
              <div className="rsvp-choice" role="radiogroup" aria-label="Will you attend?"
                aria-describedby={errors.attending ? "attending-error" : undefined}>
                <label className={draft.attending === "yes" ? "selected" : ""}>
                  <input type="radio" name="attending" value="yes" checked={draft.attending === "yes"} onChange={() => update("attending", "yes")} />
                  Joyfully accepts
                </label>
                <label className={draft.attending === "no" ? "selected" : ""}>
                  <input type="radio" name="attending" value="no" checked={draft.attending === "no"} onChange={() => update("attending", "no")} />
                  Regretfully declines
                </label>
              </div>
              {errors.attending && <p id="attending-error" className="rsvp-field-error">{errors.attending}</p>}

              {draft.attending === "yes" && (
                <>
                  <label className="rsvp-field">
                    <span>Meal preference</span>
                    <input value={draft.mealChoice} maxLength={MEAL_MAX} placeholder="e.g. Chicken, fish, vegetarian"
                      onChange={(e) => update("mealChoice", e.target.value)} aria-invalid={errors.mealChoice ? true : undefined} />
                    {errors.mealChoice && <small className="rsvp-field-error">{errors.mealChoice}</small>}
                  </label>
                  <label className="rsvp-field">
                    <span>Allergies or dietary needs</span>
                    <textarea rows={3} value={draft.dietaryNotes} maxLength={NOTES_MAX} placeholder="e.g. Nut allergy, gluten-free"
                      onChange={(e) => update("dietaryNotes", e.target.value)} aria-invalid={errors.dietaryNotes ? true : undefined} />
                    {errors.dietaryNotes && <small className="rsvp-field-error">{errors.dietaryNotes}</small>}
                  </label>
                  {guest.plusOneAllowed && (
                    <div className="rsvp-plus-one">
                      <span id="plus-one-label">Your invitation includes a plus-one. Will they be joining you?</span>
                      <div className="rsvp-choice small" role="radiogroup" aria-labelledby="plus-one-label">
                        <label className={draft.plusOne === "yes" ? "selected" : ""}>
                          <input type="radio" name="plusOne" value="yes" checked={draft.plusOne === "yes"} onChange={() => update("plusOne", "yes")} />
                          Yes, they're coming
                        </label>
                        <label className={draft.plusOne === "no" ? "selected" : ""}>
                          <input type="radio" name="plusOne" value="no" checked={draft.plusOne === "no"} onChange={() => update("plusOne", "no")} />
                          No, just me
                        </label>
                      </div>
                      {errors.plusOne && <p className="rsvp-field-error">{errors.plusOne}</p>}
                    </div>
                  )}
                </>
              )}
            </fieldset>
            <div className="rsvp-actions">
              {answered && (
                <Button variant="secondary" onClick={() => { setEditing(false); setDraft(draftFrom(data)); setErrors({}); setFormError(""); }} disabled={saving}>
                  Cancel
                </Button>
              )}
              <Button type="submit" disabled={saving}>{saving ? "Sending..." : answered ? "Update my RSVP" : "Send my RSVP"}</Button>
            </div>
          </form>
        )}

        <footer className="rsvp-footer">
          This link is just for you. Please don't forward it: anyone with it can change your RSVP.
        </footer>
      </article>
    </main>
  );
}
