import { Button, Card, Icon } from "../../components/ui";
import { StatCard } from "../../components/page";
import { useEvents } from "../events/EventsContext";
import { eventDate, eventInitials, eventRole } from "../events/eventPresentation";
import type { Page } from "../../types";

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { eventDetails: selectedEvent, openCreate, openEdit } = useEvents();
  if (!selectedEvent) return null;
  return (
    <>
      <div role="toolbar" aria-label="Event actions" style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 9, marginBottom: 16 }}>
        <Button variant="secondary" onClick={() => go("events")} icon="grid">View events</Button>
        <Button onClick={openCreate} icon="plus">Create event</Button>
        {selectedEvent.role === "OWNER" && <Button variant="secondary" onClick={openEdit}>Edit event</Button>}
      </div>
      <div className="dashboard-banner">
        <div>
          <div className="eyebrow">YOUR EVENT</div>
          <h2>{selectedEvent.name}</h2>
          <p>{selectedEvent.venue ?? "Venue not set"} / {eventDate(selectedEvent.event_date)}</p>
          <div className="banner-meta"><span>{eventRole(selectedEvent.role)}</span><span>{selectedEvent.template_id ? `Template ID: ${selectedEvent.template_id}` : "No template"}</span></div>
        </div>
        <div className="banner-art"><i /><i /><i /><span>{eventInitials(selectedEvent.name)}</span></div>
      </div>
      <div className="stat-grid">
        <StatCard label="Total budget" value={selectedEvent.total_budget} detail="Event budget" icon="wallet" onClick={() => go("budget")} />
        <StatCard label="Guest responses" value="--" detail="Guest information unavailable" icon="users" tone="coral" onClick={() => go("guests")} />
        <StatCard label="Tasks complete" value="--" detail="Task information unavailable" icon="check" tone="mint" onClick={() => go("tasks")} />
        <StatCard label="Upcoming payments" value="--" detail="Payment information unavailable" icon="receipt" tone="gold" onClick={() => go("expenses")} />
      </div>
      <div className="dashboard-columns">
        <Card>
          <div className="card-head"><div><h3>Budget snapshot</h3><p>Spending information is not available for this event yet.</p></div>
            <button className="text-link" onClick={() => go("budget")}>View budget <Icon name="arrow" size={14} /></button>
          </div>
        </Card>
        <Card>
          <div className="card-head"><div><h3>Tasks this week</h3><p>Task information is not available for this event yet.</p></div></div>
        </Card>
      </div>
      <Card>
        <div className="card-head"><div><h3>Next up</h3><p>Payments and milestones are not available for this event yet.</p></div>
          <button className="text-link" onClick={() => go("timeline")}>Full timeline <Icon name="arrow" size={14} /></button>
        </div>
      </Card>
    </>
  );
}
