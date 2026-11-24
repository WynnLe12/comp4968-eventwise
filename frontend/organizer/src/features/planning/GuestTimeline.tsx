// Public guest timeline (Feature 13, US41), opened from a shared link or QR code.
// No sign-in: the share token in the URL is the only credential. Refreshes every minute
// so guests see changes on the day without reloading.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Icon } from "../../components/ui";
import { GuestTimelineError, fetchGuestTimeline, type GuestTimeline as GuestTimelineData } from "./timelineApi";
import { formatDay, formatRange, formatTime, groupByDay, nextUpItemId } from "./timelineFormat";
import "./timeline.css";

const REFRESH_MS = 60_000;

export function GuestTimeline() {
  const { share = "" } = useParams<{ share: string }>();
  return <GuestSchedule key={share} share={share} />;
}

function GuestSchedule({ share }: { share: string }) {
  const [data, setData] = useState<GuestTimelineData | null>(null);
  const [error, setError] = useState<GuestTimelineError | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const timeline = await fetchGuestTimeline(share, signal);
      setData(timeline);
      setError(null);
      setLoadedAt(new Date().toISOString());
    } catch (caught) {
      if (signal.aborted) return;
      setError(caught instanceof GuestTimelineError ? caught : new GuestTimelineError("Something went wrong.", false));
    }
  }, [share]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // Refresh while the page is visible; an invalid link stops refreshing.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(controller.signal);
    }, REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, attempt]);

  const groups = useMemo(() => groupByDay(data?.items ?? []), [data]);
  const nextUp = useMemo(() => nextUpItemId(data?.items ?? [], new Date()), [data, loadedAt]);

  useEffect(() => {
    document.title = data ? `${data.event.name} · Timeline` : "Event timeline";
  }, [data]);

  if (error?.notFound) {
    return (
      <main className="guest-timeline">
        <div className="gt-message" role="alert">
          <Icon name="link" />
          <h1>This link doesn't work</h1>
          <p>{error.message}</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="guest-timeline">
        {error ? (
          <div className="gt-message" role="alert">
            <h1>We couldn't load the schedule</h1>
            <p>{error.message}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          </div>
        ) : (
          <p className="gt-message" role="status">Loading the schedule…</p>
        )}
      </main>
    );
  }

  const { event } = data;
  return (
    <main className="guest-timeline">
      <header className="gt-header">
        <p className="gt-eyebrow">Event schedule</p>
        <h1>{event.name}</h1>
        <p className="gt-meta">
          {event.eventDate && <span><Icon name="calendar" size={15} /> {formatDay(event.eventDate)}</span>}
          {event.venue && <span><Icon name="store" size={15} /> {event.venue}</span>}
        </p>
      </header>

      {error && <p className="gt-stale" role="status">Couldn't refresh just now. Showing the schedule as of {loadedAt ? formatTime(loadedAt) : "earlier"}.</p>}

      {data.items.length === 0 ? (
        <p className="gt-message">The hosts haven't published the schedule yet. Check back soon.</p>
      ) : (
        groups.map((group) => (
          <section className="gt-day" key={group.date} aria-label={group.label}>
            {(groups.length > 1 || group.date !== event.eventDate) && <h2>{group.label}</h2>}
            <ol>
              {group.items.map((item) => (
                <li key={item.itemId} className={item.itemId === nextUp ? "gt-next" : undefined}>
                  <time dateTime={item.startsAt}>{formatRange(item)}</time>
                  <div>
                    <h3>
                      {item.title}
                      {item.itemId === nextUp && <span className="gt-badge">Up next</span>}
                    </h3>
                    {item.place && <p className="gt-place"><Icon name="store" size={14} /> {item.place}</p>}
                    {item.notes && <p className="gt-notes">{item.notes}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}

      <footer className="gt-footer">
        Times are in Vancouver time. This page updates automatically.
      </footer>
    </main>
  );
}
