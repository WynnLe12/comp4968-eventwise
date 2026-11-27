import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Badge, Button, Card, Field, Icon, Modal, SelectField, TextAreaField } from "../../components/ui";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { useEvents } from "../events/EventsContext";
import { EventSessionError, type OrganizerEvent } from "../events/services/eventApi";
import { guestTimelinePath } from "../../routes/navigation";
import {
  TimelineApiError,
  createTimelineItem,
  deleteTimelineItem,
  getSubscription,
  getTimelineShareLink,
  listTimeline,
  subscribe,
  unsubscribe,
  type Subscription,
  updateTimelineItem,
} from "./timelineApi";
import {
  LIMITS,
  REMINDER_OPTIONS,
  VISIBILITY_OPTIONS,
  changedFields,
  dateBadge,
  emptyForm,
  formErrorsFromApi,
  formFromItem,
  formatRange,
  groupByDay,
  isNotifiableChange,
  nextUpItemId,
  reminderLabel,
  savedMessage,
  todayInVancouver,
  validateForm,
  type FormErrors,
  type TimelineForm,
  type TimelineItem,
} from "./timelineFormat";
import "./timeline.css";

type Toast = (message: string, tone?: "success" | "error") => void;

export function Timeline({ onToast }: { onToast: Toast }) {
  const { selectedEvent, status } = useEvents();
  if (!selectedEvent) {
    return (
      <>
        <PageHeader page="timeline" />
        {status === "loading" ? (
          <LoadingState label="Loading your events..." />
        ) : (
          <EmptyState title="Select an event" message="Choose an event in the sidebar to build its timeline." icon="calendar" />
        )}
      </>
    );
  }
  // A new key resets every piece of state when the user switches events.
  return <TimelineBoard key={selectedEvent.event_id} event={selectedEvent} onToast={onToast} />;
}

function TimelineBoard({ event, onToast }: { event: OrganizerEvent; onToast: Toast }) {
  const { expireSession } = useEvents();
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadCount, setReloadCount] = useState(0);
  const [guestView, setGuestView] = useState(false);
  const [editing, setEditing] = useState<TimelineItem | "new" | null>(null);
  const [deleting, setDeleting] = useState<TimelineItem | null>(null);
  const [sharing, setSharing] = useState(false);
  const eventId = event.event_id;

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    listTimeline(eventId, controller.signal)
      .then(setItems)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof EventSessionError) return expireSession();
        setLoadError(error instanceof Error ? error.message : "We couldn't load the timeline.");
      });
    return () => controller.abort();
  }, [eventId, reloadCount, expireSession]);

  /** For errors after a save or delete: session -> sign in; stale data -> toast and refresh. */
  const handleActionError = useCallback((error: unknown): boolean => {
    if (error instanceof EventSessionError) {
      expireSession();
      return true;
    }
    if (error instanceof TimelineApiError && (error.code === "VERSION_CONFLICT" || error.code === "NOT_FOUND")) {
      onToast(error.message, "error");
      reload();
      return true;
    }
    return false;
  }, [expireSession, onToast, reload]);

  const visible = useMemo(
    () => (items ?? []).filter((item) => !guestView || item.visibility === "GUESTS"),
    [items, guestView],
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const nextUp = useMemo(() => nextUpItemId(visible, new Date()), [visible]);
  const badge = dateBadge(event.event_date);
  const showDayHeadings = groups.length > 1 || (groups[0] && groups[0].date !== event.event_date?.slice(0, 10));

  const header = (
    <PageHeader
      page="timeline"
      action={
        items && items.length > 0 ? (
          <>
            <Button variant="secondary" onClick={() => setGuestView(!guestView)} icon="eye">
              {guestView ? "Planner view" : "Guest view"}
            </Button>
            <Button variant="secondary" onClick={() => setSharing(true)} icon="link">Share with guests</Button>
            {!guestView && <Button icon="plus" onClick={() => setEditing("new")}>Add activity</Button>}
          </>
        ) : undefined
      }
    />
  );

  if (loadError && !items) {
    return <>{header}<ErrorState message={loadError} onRetry={reload} /></>;
  }
  if (!items) {
    return <>{header}<LoadingState label="Loading the timeline..." /></>;
  }

  return (
    <>
      {header}
      {loadError && <div className="form-error-banner" role="alert"><Icon name="alert" /> {loadError}</div>}
      {!guestView && <EmailOptIn eventId={eventId} onSessionExpired={expireSession} />}
      {guestView && (
        <div className="guest-view-banner">
          <Icon name="eye" /> You're previewing what guests see. Planning-team-only activities are hidden.
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Plan the day, minute by minute"
          message="Add activities with a time and place. Guests see them on their timeline page, and you can send reminders before each one."
          icon="clock"
          action={<Button icon="plus" onClick={() => setEditing("new")}>Add the first activity</Button>}
        />
      ) : (
        <Card className="timeline-card">
          <div className="timeline-date">
            {badge && (
              <div>
                <small>{badge.weekday}</small>
                <strong>{badge.day}</strong>
                <span>{badge.monthYear}</span>
              </div>
            )}
            <p className={badge ? undefined : "tl-no-date"}>
              <b>{event.name}</b>
              {event.venue ?? "Venue to be decided"}
            </p>
          </div>

          {visible.length === 0 && (
            <p className="tl-empty-preview">No activities are visible to guests yet.</p>
          )}

          {groups.map((group) => (
            <section key={group.date} aria-label={group.label}>
              {showDayHeadings && <h3 className="tl-day">{group.label}</h3>}
              <ol className="timeline-list">
                {group.items.map((item) => (
                  <li className="timeline-item tl-item" key={item.itemId}>
                    <time dateTime={item.startsAt}>{formatRange(item)}</time>
                    <div className={`timeline-dot ${item.itemId === nextUp ? "active" : ""}`} aria-hidden="true" />
                    <div className="timeline-detail">
                      <b>
                        {item.title}
                        {item.visibility === "TEAM" && <Badge>Team only</Badge>}
                      </b>
                      <span>
                        {item.place && <><Icon name="store" size={14} /> {item.place}</>}
                        {!guestView && item.reminderMinutes > 0 && (
                          <>
                            <Icon name="bell" size={14} />
                            {item.reminderSent ? "Reminder sent" : reminderLabel(item.reminderMinutes)}
                          </>
                        )}
                      </span>
                      {item.notes && <p className="tl-notes">{item.notes}</p>}
                    </div>
                    {!guestView && (
                      <div className="tl-actions">
                        <button className="icon-btn" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item)}>
                          <Icon name="edit" />
                        </button>
                        <button className="icon-btn" aria-label={`Delete ${item.title}`} onClick={() => setDeleting(item)}>
                          <Icon name="trash" />
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </Card>
      )}

      {editing && (
        <ActivityEditor
          eventId={eventId}
          eventDate={event.event_date}
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            onToast(message);
            reload();
          }}
          onActionError={(error) => {
            if (handleActionError(error)) {
              setEditing(null);
              return true;
            }
            return false;
          }}
        />
      )}

      {sharing && (
        <ShareDialog
          eventId={eventId}
          eventName={event.name}
          hasGuestItems={(items ?? []).some((item) => item.visibility === "GUESTS")}
          onClose={() => setSharing(false)}
          onToast={onToast}
          onSessionExpired={expireSession}
        />
      )}

      {deleting && (
        <DeleteActivityDialog
          eventId={eventId}
          item={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(message) => {
            setDeleting(null);
            onToast(message);
            reload();
          }}
          onActionError={(error) => {
            if (handleActionError(error)) {
              setDeleting(null);
              return true;
            }
            return false;
          }}
        />
      )}
    </>
  );
}

// --- Add / edit ------------------------------------------------------------------

function ActivityEditor({
  eventId,
  eventDate,
  item,
  onClose,
  onSaved,
  onActionError,
}: {
  eventId: string;
  eventDate: string | null;
  item: TimelineItem | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onActionError: (error: unknown) => boolean;
}) {
  const [form, setForm] = useState<TimelineForm>(() => (item ? formFromItem(item) : emptyForm(eventDate)));
  const [errors, setErrors] = useState<FormErrors>({});
  const [notify, setNotify] = useState(false);
  const [saving, setSaving] = useState(false);
  const formId = item ? `timeline-edit-${item.itemId}` : "timeline-new";

  const set = <K extends keyof TimelineForm>(key: K, value: TimelineForm[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (errors[key] || errors.form) setErrors((previous) => ({ ...previous, [key]: undefined, form: undefined }));
  };

  // Whether ticking "notify" would actually send anything for the current edits.
  const pending = useMemo(() => {
    if (!item) return null;
    const { fields } = validateForm(form, { item });
    return fields ? changedFields(item, fields) : null;
  }, [form, item]);
  const notifiable = Boolean(pending && isNotifiableChange(pending));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { errors: found, fields } = validateForm(form, { item });
    if (!fields) {
      setErrors(found);
      return;
    }
    setSaving(true);
    try {
      if (!item) {
        await createTimelineItem(eventId, fields);
        onSaved("Activity added.");
        return;
      }
      const changes = changedFields(item, fields);
      if (Object.keys(changes).length === 0) {
        onSaved("No changes to save.");
        return;
      }
      const result = await updateTimelineItem(eventId, item.itemId, item.version, changes, notify && notifiable);
      onSaved(savedMessage("Saved", result.notification));
    } catch (error) {
      if (onActionError(error)) return;
      if (error instanceof TimelineApiError && error.status === 422) {
        setErrors({ form: error.message, ...formErrorsFromApi(error.fields) });
      } else {
        setErrors({ form: error instanceof Error ? error.message : "Something went wrong. Please try again." });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={item ? "Edit activity" : "Add activity"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form={formId} disabled={saving}>{saving ? "Saving..." : item ? "Save changes" : "Add activity"}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        {errors.form && (
          <div className="form-error-banner" role="alert"><Icon name="alert" /> {errors.form}</div>
        )}
        <Field
          label="Activity"
          placeholder="e.g. Ceremony begins"
          value={form.title}
          maxLength={LIMITS.title}
          error={errors.title}
          onChange={(e) => set("title", e.target.value)}
        />
        <div className="form-row">
          <Field
            label="Date"
            type="date"
            // Like the event date: no past days. An activity that's already over keeps its own date.
            min={item && formFromItem(item).date < todayInVancouver() ? undefined : todayInVancouver()}
            value={form.date}
            error={errors.date}
            onChange={(e) => set("date", e.target.value)}
          />
          <Field label="Starts" type="time" value={form.startTime} error={errors.startTime} onChange={(e) => set("startTime", e.target.value)} />
          <Field
            label="Ends (optional)"
            type="time"
            value={form.endTime}
            error={errors.endTime}
            hint={form.endTime && form.startTime && form.endTime < form.startTime ? "Ends the next day" : undefined}
            onChange={(e) => set("endTime", e.target.value)}
          />
        </div>
        <Field
          label="Place (optional)"
          placeholder="e.g. Garden ceremony"
          value={form.place}
          maxLength={LIMITS.place}
          error={errors.place}
          onChange={(e) => set("place", e.target.value)}
        />
        <div className="form-row">
          <SelectField
            label="Who sees it"
            value={form.visibility}
            options={VISIBILITY_OPTIONS}
            error={errors.visibility}
            onChange={(e) => set("visibility", e.target.value as TimelineForm["visibility"])}
          />
          <SelectField
            label="Reminder email"
            value={form.reminderMinutes}
            options={REMINDER_OPTIONS}
            error={errors.reminderMinutes}
            onChange={(e) => set("reminderMinutes", e.target.value)}
          />
        </div>
        <TextAreaField
          label="Notes (optional)"
          rows={3}
          value={form.notes}
          maxLength={LIMITS.notes}
          error={errors.notes}
          hint={form.visibility === "GUESTS" ? "Guests can see these notes." : undefined}
          onChange={(e) => set("notes", e.target.value)}
        />
        <p className="tl-time-zone">Times are in Vancouver time.</p>
        {item && (
          <label className="check-field">
            <input
              type="checkbox"
              checked={notify && notifiable}
              disabled={!notifiable}
              onChange={(e) => setNotify(e.target.checked)}
            />
            <div>
              <b>Email affected people about this change</b>
              <span>
                {notifiable
                  ? form.visibility === "TEAM" && item.visibility === "TEAM"
                    ? "Planners who turned on timeline emails."
                    : "Planners who turned on timeline emails, and guests with an email address."
                  : "Available when the name, time, place or visibility changes."}
              </span>
            </div>
          </label>
        )}
      </form>
    </Modal>
  );
}

// --- Delete ------------------------------------------------------------------------

function DeleteActivityDialog({
  eventId,
  item,
  onClose,
  onDeleted,
  onActionError,
}: {
  eventId: string;
  item: TimelineItem;
  onClose: () => void;
  onDeleted: (message: string) => void;
  onActionError: (error: unknown) => boolean;
}) {
  const [notify, setNotify] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setDeleting(true);
    setError("");
    try {
      await deleteTimelineItem(eventId, item.itemId, notify);
      onDeleted(notify ? "Activity deleted. Affected people will be emailed." : "Activity deleted.");
    } catch (caught) {
      if (onActionError(caught)) return;
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      title="Delete activity?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deleting}>Cancel</Button>
          <Button variant="danger" icon="trash" onClick={confirm} disabled={deleting}>{deleting ? "Deleting..." : "Delete"}</Button>
        </>
      }
    >
      {error && <div className="form-error-banner" role="alert"><Icon name="alert" /> {error}</div>}
      <p className="tl-delete-text">
        <b>{item.title}</b> ({formatRange(item)}) will be removed from the timeline{item.visibility === "GUESTS" ? " and the guest page" : ""}.
        Any reminder for it is cancelled.
      </p>
      <label className="check-field">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        <div>
          <b>Email affected people that it was removed</b>
          <span>
            {item.visibility === "TEAM"
              ? "Planners who turned on timeline emails."
              : "Planners who turned on timeline emails, and guests with an email address."}
          </span>
        </div>
      </label>
    </Modal>
  );
}

// --- Share with guests ----------------------------------------------------------------

function ShareDialog({
  eventId,
  eventName,
  hasGuestItems,
  onClose,
  onToast,
  onSessionExpired,
}: {
  eventId: string;
  eventName: string;
  hasGuestItems: boolean;
  onClose: () => void;
  onToast: Toast;
  onSessionExpired: () => void;
}) {
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getTimelineShareLink(eventId, controller.signal)
      .then(async ({ share }) => {
        // Built from this page's origin (like the photo gallery link), so it works locally and on Amplify.
        const url = new URL(guestTimelinePath(share), window.location.origin).href;
        const qr = await QRCode.toDataURL(url, { width: 320, margin: 4 });
        if (!controller.signal.aborted) setLink({ url, qr });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof EventSessionError) return onSessionExpired();
        setError(caught instanceof Error ? caught.message : "We couldn't create the guest link.");
      });
    return () => controller.abort();
  }, [eventId, onSessionExpired]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      onToast("Guest link copied.");
    } catch {
      onToast("Couldn't copy automatically. Select the link and copy it.", "error");
    }
  }

  return (
    <Modal title="Share the schedule with guests" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      {error && <div className="form-error-banner" role="alert"><Icon name="alert" /> {error}</div>}
      {!link && !error && <p className="tl-time-zone" role="status">Creating the guest link…</p>}
      {link && (
        <div className="tl-share">
          <img src={link.qr} alt={`QR code for the ${eventName} schedule`} />
          <div>
            <p>
              Anyone with this link can see the activities marked <b>Guests and planning team</b>, without signing in.
              Team-only activities stay private.
            </p>
            {!hasGuestItems && <p className="tl-share-warning">No activities are visible to guests yet.</p>}
            <label className="field">
              <span>Guest link</span>
              <input readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="tl-share-actions">
              <Button icon="link" onClick={() => void copy()}>Copy link</Button>
              <a className="btn btn-secondary" href={link.url} target="_blank" rel="noopener noreferrer">
                <Icon name="eye" size={16} /> Open guest page
              </a>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// --- "Email me timeline updates" ------------------------------------------------------

function EmailOptIn({ eventId, onSessionExpired }: { eventId: string; onSessionExpired: () => void }) {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getSubscription(eventId, controller.signal)
      .then(setSubscription)
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof EventSessionError) return onSessionExpired();
        setError("Couldn't load your email setting.");
      });
    return () => controller.abort();
  }, [eventId, onSessionExpired]);

  async function toggle(on: boolean) {
    setSaving(true);
    setError("");
    try {
      if (on) setSubscription(await subscribe(eventId));
      else {
        await unsubscribe(eventId);
        setSubscription({ subscribed: false, email: null });
      }
    } catch (caught) {
      if (caught instanceof EventSessionError) return onSessionExpired();
      setError(caught instanceof Error ? caught.message : "Couldn't change your email setting.");
    } finally {
      setSaving(false);
    }
  }

  const on = Boolean(subscription?.subscribed);
  return (
    <label className={`check-field tl-optin ${on ? "is-on" : ""}`}>
      <input
        type="checkbox"
        checked={on}
        disabled={!subscription || saving}
        onChange={(e) => void toggle(e.target.checked)}
      />
      <div>
        <b>Email me timeline updates</b>
        <span>
          {error
            ? error
            : on
              ? `Reminders and changes for this event go to ${subscription?.email}.`
              : "Get activity reminders and an email when someone changes this timeline."}
        </span>
      </div>
      <Icon name="bell" />
    </label>
  );
}
