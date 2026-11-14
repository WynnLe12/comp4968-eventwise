import type { ReactNode } from "react";
import { EmptyState, LoadingState, PageHeader } from "../../components/page";
import { Button } from "../../components/ui";
import type { Page } from "../../types";
import { GUESTS_USE_MOCK } from "../guests/services/guestApi";
import { useEvents } from "./EventsContext";

export function EventWorkspace({ page, children }: { page: Page; children: ReactNode }) {
  const { status, error, refresh, openCreate, detailsStatus, detailsError, detailsErrorStatus, reloadDetails } = useEvents();
  if (page === "templates") return children;
  // Hardcoded guests don't depend on the event list, so show them even if events can't load.
  if (page === "guests" && GUESTS_USE_MOCK) return <>
    <p className="feature-preview-notice" role="status">
      Preview: sample guests. This list isn't loaded from your selected event yet.
    </p>
    {children}
  </>;
  if (status === "loading") return <LoadingState label="Loading your events..." />;
  if (status === "error") return (
    <div role="alert"><EmptyState title="Unable to load events" message={error}
      action={<Button onClick={() => void refresh()}>Try again</Button>} /></div>
  );
  if (status === "empty") return <EmptyState title="No events yet" message="There are no events available for your account." action={<Button onClick={openCreate} icon="plus">Create event</Button>} />;
  if (page === "dashboard") {
    if (detailsStatus === "idle") return <EmptyState title="Select an event" message="Choose an event from the event switcher to view its dashboard." />;
    if (detailsStatus === "loading") return <LoadingState label="Loading event details..." />;
    if (detailsStatus === "error") return (
      <div role="alert"><EmptyState title={detailsErrorStatus === 403 ? "Event access unavailable" : detailsErrorStatus === 404 ? "Event not found" : "Unable to load event details"}
        message={detailsError} action={<>
          {detailsErrorStatus !== 403 && detailsErrorStatus !== 404 && <Button onClick={reloadDetails}>Try again</Button>}
          <Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>
        </>} /></div>
    );
  }
  if (page === "vendors" || page === "expenses") return <>
    <p className="feature-preview-notice" role="status">
      Preview: sample vendors and expenses. Changes aren't saved to your selected event and reset on refresh.
    </p>
    {children}
  </>;
  // Keep unconnected feature screens from presenting sample data as this event's data.
  if (page !== "dashboard" && page !== "events" && page !== "budget" && page !== "guests") return <>
    <PageHeader page={page} />
    <EmptyState title="Event information unavailable" message="This section is not available for this event yet." />
  </>;
  return children;
}
