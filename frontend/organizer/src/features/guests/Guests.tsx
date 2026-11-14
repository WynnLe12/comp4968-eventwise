import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Card, Icon } from "../../components/ui";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { useResource } from "../../hooks/useResource";
import { useEvents } from "../events/EventsContext";
import {
  isRsvpStatus,
  listGuests,
  RSVP_LABELS,
  RSVP_STATUSES,
  type GuestRecord,
  type RsvpStatus,
} from "./services/guestApi";
import { AddGuestModal } from "./AddGuestModal";
import { EditGuestModal } from "./EditGuestModal";
import "./guests.css";

const rsvpTone: Record<RsvpStatus, string> = {
  UNINVITED: "neutral",
  PENDING: "warning",
  ACCEPTED: "success",
  REJECTED: "danger",
};

const rsvpDisplay = Object.fromEntries(
  RSVP_STATUSES.map((status) => [status, { label: RSVP_LABELS[status], tone: rsvpTone[status] }]),
) as Record<RsvpStatus, { label: string; tone: string }>;

type StatusFilter = "ALL" | RsvpStatus;

function guestName(guest: GuestRecord) {
  return [guest.firstName, guest.lastName].filter(Boolean).join(" ") || guest.email || "Unnamed guest";
}

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .slice(0, 2)
    .join("");

function errorText(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Unable to load your guest list.";
}

export function Guests({
  onToast,
}: {
  onToast: (message: string, tone?: "success" | "error") => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const { selectedEvent, status: eventsStatus } = useEvents();
  // The event chosen in the sidebar switcher. Changing it reloads the guest list for that event.
  const eventId = selectedEvent?.event_id ?? null;

  const loadGuests = useCallback(
    () => (eventId ? listGuests(eventId) : Promise.resolve<GuestRecord[]>([])),
    [eventId],
  );
  const { data, loading, error, reload } = useResource(loadGuests);
  const guests = useMemo(() => data ?? [], [data]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingGuest = editingId ? guests.find((g) => g.guestId === editingId) : undefined;
  const [adding, setAdding] = useState(false);

  const openAdd = () => setAdding(true);
  const addModal =
    adding && eventId ? (
      <AddGuestModal
        eventId={eventId}
        onClose={() => setAdding(false)}
        onAdded={(name) => {
          setAdding(false);
          onToast(name ? `${name} added to your guest list` : "Guest added");
          reload(); // Show the guest as the backend stored it.
        }}
      />
    ) : null;

  const counts = useMemo(() => {
    const byStatus = Object.fromEntries(RSVP_STATUSES.map((status) => [status, 0])) as Record<
      RsvpStatus,
      number
    >;
    for (const guest of guests) byStatus[guest.rsvpStatus] += 1;
    return byStatus;
  }, [guests]);

  if (!eventId)
    return (
      <>
        <PageHeader page="guests" />
        {eventsStatus === "loading" ? (
          <LoadingState label="Loading your events..." />
        ) : (
          <EmptyState
            title="Select an event"
            message="Choose an event in the sidebar to see its guest list."
            icon="calendar"
          />
        )}
      </>
    );

  if (loading)
    return (
      <>
        <PageHeader page="guests" />
        <LoadingState label="Loading your guest list..." />
      </>
    );

  if (error)
    return (
      <>
        <PageHeader page="guests" />
        <ErrorState message={errorText(error)} onRetry={reload} />
      </>
    );

  if (!guests.length)
    return (
      <>
        <PageHeader page="guests" />
        <EmptyState
          title="Your guest list is ready to grow"
          message="Add guests one by one to begin collecting RSVPs."
          action={
            <Button onClick={openAdd} icon="plus">
              Add guest
            </Button>
          }
        />
        {addModal}
      </>
    );

  const needle = query.trim().toLowerCase();
  const filtered = guests.filter(
    (g) =>
      (statusFilter === "ALL" || g.rsvpStatus === statusFilter) &&
      (!needle ||
        guestName(g).toLowerCase().includes(needle) ||
        (g.email ?? "").toLowerCase().includes(needle)),
  );

  return (
    <>
      <PageHeader
        page="guests"
        action={
          <Button onClick={openAdd} icon="plus">
            Add guest
          </Button>
        }
      />
      <div className="guest-summary">
        <div>
          <b>{counts.ACCEPTED}</b>
          <span>Accepted</span>
          <i className="green" />
        </div>
        <div>
          <b>{counts.REJECTED}</b>
          <span>Rejected</span>
          <i className="coral" />
        </div>
        <div>
          <b>{counts.PENDING}</b>
          <span>Pending</span>
          <i className="gray" />
        </div>
        <div>
          <b>{guests.length}</b>
          <span>Total guests</span>
        </div>
      </div>
      <Card>
        <div className="table-toolbar">
          <div className="search-input">
            <Icon name="search" />
            <input
              placeholder="Search guests..."
              aria-label="Search guests"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="toolbar-actions">
            <select
              className="guest-status-filter"
              aria-label="Filter by RSVP status"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(isRsvpStatus(e.target.value) ? e.target.value : "ALL")
              }
            >
              <option value="ALL">All RSVP statuses</option>
              {RSVP_STATUSES.map((status) => (
                <option value={status} key={status}>
                  {rsvpDisplay[status].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Guest</th>
                <th>Party size</th>
                <th>RSVP</th>
                <th>Meal choice</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => {
                const name = guestName(g);
                const status = rsvpDisplay[g.rsvpStatus];
                const hasName = Boolean(g.firstName || g.lastName);
                return (
                  <tr key={g.guestId}>
                    <td>
                      <div className="guest-name">
                        <span>{initials(name)}</span>
                        <b>
                          {name}
                          {g.plusOneAllowed && <small> + plus-one</small>}
                          {hasName && g.email && <small> · {g.email}</small>}
                        </b>
                      </div>
                    </td>
                    <td>{g.plusOneAllowed ? 2 : 1}</td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td>{g.mealChoice ?? "Not selected"}</td>
                    <td>
                      <button
                        className="icon-btn"
                        aria-label={`Edit ${name}`}
                        title="Edit guest"
                        onClick={() => setEditingId(g.guestId)}
                      >
                        <Icon name="more" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="guest-no-match">
                    No guests match your filters.{" "}
                    <button
                      className="text-link"
                      onClick={() => {
                        setQuery("");
                        setStatusFilter("ALL");
                      }}
                    >
                      Clear filters
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {addModal}
      {editingGuest && (
        <EditGuestModal
          key={editingGuest.guestId}
          guest={editingGuest}
          eventId={eventId}
          onClose={() => setEditingId(null)}
          onDeleted={(name) => {
            setEditingId(null);
            onToast(`${name} removed from your guest list`);
            reload(); // Show the list as the backend now has it.
          }}
          onSaved={(name) => {
            setEditingId(null);
            onToast(name ? `${name}'s details saved` : "Guest details saved");
            reload(); // Show the guest as the backend now has it.
          }}
        />
      )}
    </>
  );
}
