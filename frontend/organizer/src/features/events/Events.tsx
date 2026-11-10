import { Badge, Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";
import type { Page } from "../../types";

function EventProgress({ percent }: { percent: number }) {
  return (
    <div className="event-progress">
      <div>
        <span>Planning progress</span>
        <b>{percent}%</b>
      </div>
      <i>
        <span style={{ width: `${percent}%` }} />
      </i>
    </div>
  );
}

export function Events({ onCreate, go }: { onCreate: () => void; go: (p: Page) => void }) {
  return (
    <>
      <PageHeader
        page="events"
        action={
          <Button onClick={onCreate} icon="plus">
            Create event
          </Button>
        }
      />
      <div className="events-grid">
        <Card className="event-card current">
          <div className="event-cover wedding-cover">
            <div className="cover-monogram">
              M <small>&</small> E
            </div>
            <Badge tone="success">Current event</Badge>
          </div>
          <div className="event-body">
            <div>
              <h3>Maya & Eli’s Wedding</h3>
              <p>
                <Icon name="calendar" size={15} />
                Sep 20, 2025 · The Willow House
              </p>
            </div>
            <button className="icon-btn" aria-label="More options">
              <Icon name="more" />
            </button>
          </div>
          <EventProgress percent={68} />
          <div className="event-footer">
            <span>120 guests</span>
            <span>$35,000 budget</span>
            <Button variant="secondary" onClick={() => go("dashboard")}>
              Open event
            </Button>
          </div>
        </Card>
        <Card className="event-card">
          <div className="event-cover birthday-cover">
            <div className="cover-monogram">60</div>
          </div>
          <div className="event-body">
            <div>
              <h3>Mom’s 60th Birthday</h3>
              <p>
                <Icon name="calendar" size={15} />
                Nov 08, 2025 · Garden Room
              </p>
            </div>
            <button className="icon-btn" aria-label="More options">
              <Icon name="more" />
            </button>
          </div>
          <EventProgress percent={24} />
          <div className="event-footer">
            <span>48 guests</span>
            <span>$6,000 budget</span>
            <Button variant="secondary">Switch event</Button>
          </div>
        </Card>
        <button className="new-event-card" onClick={onCreate}>
          <span>
            <Icon name="plus" size={24} />
          </span>
          <b>Create a new event</b>
          <small>Start from a template or from scratch</small>
        </button>
      </div>
    </>
  );
}
