// Invitations & RSVP for organizers (Feature 8). Sets the RSVP deadline, start time,
// reminder and note, sends each guest a private RSVP link by email, and shows where
// responses stand. Guests answer on the public /rsvp/:token page (GuestRsvp.tsx).

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { Button, Card, Field, SelectField, TextAreaField } from "../../components/ui";
import { useEvents } from "../events/EventsContext";
import { EventSessionError } from "../events/services/eventApi";
import { listGuests, RSVP_LABELS, RSVP_STATUSES, type GuestRecord, type RsvpStatus } from "./services/guestApi";
import {
  formatEventDate,
  formatInstant,
  formatStartTime,
  getRsvpSettings,
  RsvpApiError,
  sendInvitations,
  type RsvpSettings,
} from "./services/rsvpApi";
import "./invitations.css";

const FORM_ID = "rsvp-settings-form";
const DAY_MS = 24 * 60 * 60 * 1000;
const MESSAGE_MAX = 1000;
const REMINDER_OPTIONS = [
  { value: "0", label: "No reminder" },
  { value: "1", label: "1 day before the deadline" },
  { value: "2", label: "2 days before the deadline" },
  { value: "3", label: "3 days before the deadline" },
  { value: "7", label: "1 week before the deadline" },
];
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

interface Draft {
  startTime: string;
  /** datetime-local value in the organizer's own time zone, e.g. "2026-11-30T23:59". */
  deadline: string;
  reminderDays: string;
  message: string;
  includePending: boolean;
}

interface Loaded {
  eventId: string;
  settings: RsvpSettings | null;
  guests: GuestRecord[];
}

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in the browser's time zone. */
function toLocalInput(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

/** Starting values: the saved settings, or a deadline one week before the event at 11:59 PM. */
function initialDraft(settings: RsvpSettings | null, eventDate: string | null): Draft {
  if (settings) {
    const days = settings.reminderAt ? Math.round((Date.parse(settings.deadline) - Date.parse(settings.reminderAt)) / DAY_MS) : 0;
    return {
      startTime: settings.startTime ?? "",
      deadline: toLocalInput(new Date(settings.deadline)),
      reminderDays: REMINDER_OPTIONS.some((option) => option.value === String(days)) ? String(days) : "0",
      message: settings.message ?? "",
      includePending: false,
    };
  }
  let deadline = "";
  if (eventDate) {
    const suggested = new Date(`${eventDate}T23:59:00`);
    suggested.setDate(suggested.getDate() - 7);
    if (suggested.getTime() > Date.now()) deadline = toLocalInput(suggested);
  }
  return { startTime: "", deadline, reminderDays: "2", message: "", includePending: false };
}

function sentSummary(queued: number, failed: number, skipped: number): string {
  const parts = [queued === 0 ? "No new invitations to send" : `Sent ${queued} invitation${queued === 1 ? "" : "s"}`];
  if (failed) parts.push(`${failed} couldn't be sent; send again to retry them`);
  if (skipped) parts.push(`${skipped} guest${skipped === 1 ? " has" : "s have"} no email address`);
  return `RSVP settings saved. ${parts.join(". ")}.`;
}

export function Invitations() {
  const { selectedEvent, expireSession } = useEvents();
  const eventId = selectedEvent?.event_id ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoaded(null);
    setLoadError("");
    if (!eventId) return;
    const controller = new AbortController();
    Promise.all([getRsvpSettings(eventId, controller.signal), listGuests(eventId)])
      .then(([settings, guests]) => {
        if (!controller.signal.aborted) setLoaded({ eventId, settings, guests });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof EventSessionError) expireSession();
        setLoadError(error instanceof Error ? error.message : "We couldn't load your invitations.");
      });
    return () => controller.abort();
  }, [eventId, attempt, expireSession]);

  if (!eventId) {
    return (
      <>
        <PageHeader page="invitations" />
        <EmptyState title="Select an event" message="Choose an event in the sidebar to send its invitations." icon="calendar" />
      </>
    );
  }
  if (loadError) {
    return (
      <>
        <PageHeader page="invitations" />
        <ErrorState message={loadError} onRetry={() => setAttempt((value) => value + 1)} />
      </>
    );
  }
  if (!loaded || loaded.eventId !== eventId) {
    return (
      <>
        <PageHeader page="invitations" />
        <LoadingState label="Loading your invitations..." />
      </>
    );
  }
  return (
    <InvitationBuilder
      key={eventId}
      eventId={eventId}
      eventName={selectedEvent?.name ?? "Your event"}
      eventDate={selectedEvent?.event_date ?? null}
      venue={selectedEvent?.venue ?? null}
      loaded={loaded}
      onSaved={(settings, guests) => setLoaded({ eventId, settings, guests })}
      onSessionExpired={expireSession}
    />
  );
}

function InvitationBuilder({
  eventId,
  eventName,
  eventDate,
  venue,
  loaded,
  onSaved,
  onSessionExpired,
}: {
  eventId: string;
  eventName: string;
  eventDate: string | null;
  venue: string | null;
  loaded: Loaded;
  onSaved: (settings: RsvpSettings, guests: GuestRecord[]) => void;
  onSessionExpired: () => void;
}) {
  const { settings, guests } = loaded;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(settings, settings?.eventDate ?? eventDate));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);

  const counts = useMemo(() => {
    const byStatus = Object.fromEntries(RSVP_STATUSES.map((status) => [status, 0])) as Record<RsvpStatus, number>;
    for (const guest of guests) byStatus[guest.rsvpStatus] += 1;
    const invitable = guests.filter((guest) => guest.rsvpStatus === "UNINVITED" || (draft.includePending && guest.rsvpStatus === "PENDING"));
    const noEmail = invitable.filter((guest) => !guest.email || !EMAIL.test(guest.email)).length;
    return { byStatus, willEmail: invitable.length - noEmail, noEmail };
  }, [guests, draft.includePending]);

  const update = useCallback(<K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: "" } : current));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const deadline = draft.deadline ? new Date(draft.deadline) : null;
    if (!deadline || Number.isNaN(deadline.getTime())) {
      setErrors({ deadline: "Choose an RSVP deadline." });
      return;
    }
    setSending(true);
    setFormError("");
    setNotice("");
    try {
      const result = await sendInvitations(eventId, {
        deadline: deadline.toISOString(),
        startTime: draft.startTime || null,
        reminderDaysBefore: Number(draft.reminderDays),
        message: draft.message.trim() || null,
        includePending: draft.includePending,
      });
      // Statuses changed for everyone who was emailed; reload the list for accurate counts.
      const refreshed = await listGuests(eventId).catch(() => guests);
      setNotice(sentSummary(result.queued, result.failed, result.skippedNoEmail));
      setDraft((current) => ({ ...current, includePending: false }));
      onSaved(result.settings, refreshed);
    } catch (error) {
      if (error instanceof EventSessionError) {
        onSessionExpired();
        return;
      }
      if (error instanceof RsvpApiError && Object.keys(error.fields).length) {
        setErrors({
          ...error.fields,
          ...(error.fields.reminderDaysBefore ? { reminderDays: error.fields.reminderDaysBefore } : {}),
        });
      }
      setFormError(error instanceof Error ? error.message : "We couldn't send your invitations. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const shownDate = settings?.eventDate ?? eventDate;
  const shownVenue = settings?.venue ?? venue;
  const previewDeadline = draft.deadline && !Number.isNaN(Date.parse(draft.deadline)) ? formatInstant(new Date(draft.deadline).toISOString()) : null;
  const reminderDays = Number(draft.reminderDays);
  const buttonLabel = counts.willEmail > 0
    ? `Save and send ${counts.willEmail} invitation${counts.willEmail === 1 ? "" : "s"}`
    : settings ? "Save RSVP settings" : "Save and send invitations";

  return (
    <>
      <PageHeader page="invitations" />

      <section className="rsvp-status" aria-label="RSVP status">
        <div className={`rsvp-status-main ${settings?.status === "CLOSED" ? "closed" : ""}`}>
          {!settings && <><b>Invitations not sent yet</b><span>Set a deadline and send each guest a private RSVP link.</span></>}
          {settings?.status === "OPEN" && <><b>RSVPs open until {formatInstant(settings.deadline)}</b>
            <span>
              {settings.reminderSentAt ? `Reminder sent ${formatInstant(settings.reminderSentAt)}.`
                : settings.reminderAt ? `One reminder goes to guests who haven't answered on ${formatInstant(settings.reminderAt)}.`
                : "No reminder scheduled."}
            </span></>}
          {settings?.status === "CLOSED" && <><b>RSVPs closed</b>
            <span>The deadline was {formatInstant(settings.deadline)}. Send again with a new deadline to reopen them.</span></>}
        </div>
        {RSVP_STATUSES.map((status) => (
          <div className={`rsvp-count ${status.toLowerCase()}`} key={status}>
            <b>{counts.byStatus[status]}</b>
            <span>{RSVP_LABELS[status]}</span>
          </div>
        ))}
      </section>

      <div className="invite-builder">
        <Card className="invite-preview">
          <div className="paper-invite" aria-label="Invitation preview">
            <small>YOU'RE INVITED</small>
            <h2>{settings?.eventName ?? eventName}</h2>
            {draft.message.trim() && <p className="invite-message">{draft.message.trim()}</p>}
            <strong>
              {shownDate ? formatEventDate(shownDate).toUpperCase() : "DATE TO BE ANNOUNCED"}
              {draft.startTime && ` · ${formatStartTime(draft.startTime)}`}
            </strong>
            {shownVenue && <span>{shownVenue}</span>}
            <span className="invite-deadline">{previewDeadline ? `Please reply by ${previewDeadline}` : "Choose an RSVP deadline"}</span>
            <button type="button" tabIndex={-1} aria-hidden="true">RSVP</button>
          </div>
        </Card>

        <Card className="invite-settings">
          <h3>Invitation details</h3>
          <form id={FORM_ID} onSubmit={submit} noValidate>
            {formError && <p className="guest-form-error" role="alert">{formError}</p>}
            {notice && <p className="rsvp-notice" role="status">{notice}</p>}
            <fieldset className="guest-form-fieldset" disabled={sending}>
              <div className="form-row">
                <Field label="Event start time" type="time" value={draft.startTime} error={errors.startTime}
                  hint="Shown on the invitation" onChange={(e) => update("startTime", e.target.value)} />
                <Field label="RSVP deadline" type="datetime-local" value={draft.deadline} error={errors.deadline}
                  onChange={(e) => update("deadline", e.target.value)} />
              </div>
              <SelectField label="Reminder" options={REMINDER_OPTIONS} value={draft.reminderDays} error={errors.reminderDays}
                hint={reminderDays > 0 ? "Sent once, only to guests who haven't answered." : undefined}
                onChange={(e) => update("reminderDays", e.target.value)} />
              <TextAreaField label="Message to guests (optional)" rows={3} maxLength={MESSAGE_MAX} value={draft.message}
                error={errors.message} placeholder="We can't wait to celebrate with you!"
                onChange={(e) => update("message", e.target.value)} />
              {counts.byStatus.PENDING > 0 && (
                <label className="check-field">
                  <input type="checkbox" checked={draft.includePending} onChange={(e) => update("includePending", e.target.checked)} />
                  <div>
                    <b>Also re-send to guests who haven't answered</b>
                    <span>{counts.byStatus.PENDING} guest{counts.byStatus.PENDING === 1 ? " is" : "s are"} still pending.</span>
                  </div>
                </label>
              )}
              {counts.noEmail > 0 && (
                <p className="rsvp-hint">
                  {counts.noEmail} guest{counts.noEmail === 1 ? " has" : "s have"} no email address and won't be emailed.
                  Add one on the Guests page, or copy their RSVP link from the guest's edit form.
                </p>
              )}
            </fieldset>
          </form>
          <Button type="submit" form={FORM_ID} icon="mail" disabled={sending}>
            {sending ? "Sending..." : buttonLabel}
          </Button>
        </Card>
      </div>
    </>
  );
}
