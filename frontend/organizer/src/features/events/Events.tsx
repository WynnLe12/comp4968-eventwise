import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";
import type { Page } from "../../types";
import { useEvents } from "./EventsContext";
import { eventDate, eventInitials, eventRole } from "./eventPresentation";

export function Events({ go }: { go: (p: Page) => void }) {
  const { events, selectedEvent, selectEvent, openCreate } = useEvents();
  return (
    <>
      <PageHeader page="events" action={<Button onClick={openCreate} icon="plus">Create event</Button>} />
      <div className="events-grid">
        {events.map((event) => (
          <Card key={event.event_id} className={`event-card${selectedEvent?.event_id === event.event_id ? " current" : ""}`}>
            <div className="event-cover wedding-cover">
              <div className="cover-monogram">{eventInitials(event.name)}</div>
              {selectedEvent?.event_id === event.event_id && <Badge tone="success">Current event</Badge>}
            </div>
            <div className="event-body">
              <div>
                <h3>{event.name}</h3>
                <p><Icon name="calendar" size={15} />{eventDate(event.event_date)}{event.venue ? ` / ${event.venue}` : ""}</p>
              </div>
            </div>
            <div className="event-footer">
              <span>{eventRole(event.role)}</span>
              <span>{event.total_budget} budget</span>
              <Button variant="secondary" onClick={() => { selectEvent(event.event_id); go("dashboard"); }}>
                {selectedEvent?.event_id === event.event_id ? "Open event" : "Switch event"}
              </Button>
            </div>
          </Card>
        ))}
        <button className="new-event-card" onClick={openCreate}>
          <span><Icon name="plus" size={24} /></span><b>Create a new event</b>
          <small>Start from a template or from scratch</small>
        </button>
      </div>
    </>
  );
}
