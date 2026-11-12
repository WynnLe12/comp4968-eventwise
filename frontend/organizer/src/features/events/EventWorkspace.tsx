import type { ReactNode } from "react";
import { EmptyState, LoadingState, PageHeader } from "../../components/page";
import { Button } from "../../components/ui";
import type { Page } from "../../types";
import { useEvents } from "./EventsContext";

export function EventWorkspace({ page, children }: { page: Page; children: ReactNode }) {
  const { status, error, refresh, openCreate } = useEvents();
  if (status === "loading") return <LoadingState label="Loading your events..." />;
  if (status === "error") return (
    <div role="alert"><EmptyState title="Unable to load events" message={error}
      action={<Button onClick={() => void refresh()}>Try again</Button>} /></div>
  );
  if (status === "empty") return <EmptyState title="No events yet" message="There are no events available for your account." action={<Button onClick={openCreate} icon="plus">Create event</Button>} />;
  // Keep unconnected feature screens from presenting sample data as this event's data.
  if (page !== "dashboard" && page !== "events") return <>
    <PageHeader page={page} />
    <EmptyState title="Event information unavailable" message="This section is not available for this event yet." />
  </>;
  return children;
}
