import { useState } from "react";
import { Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const schedule = [
  { time: "2:00 PM", title: "Vendor arrival & setup", audience: "Team only", place: "The Willow House", teamOnly: true },
  { time: "4:00 PM", title: "Ceremony begins", audience: "All guests", place: "Garden ceremony" },
  { time: "4:30 PM", title: "Cocktail hour", audience: "All guests", place: "Terrace" },
  { time: "5:45 PM", title: "Grand entrance & dinner", audience: "All guests", place: "Main hall" },
  { time: "7:15 PM", title: "Toasts & first dance", audience: "All guests", place: "Main hall" },
  { time: "8:00 PM", title: "Dancing", audience: "All guests", place: "Main hall" },
  { time: "10:45 PM", title: "Last dance & send-off", audience: "All guests", place: "Front drive" },
];

export function Timeline() {
  const [guestView, setGuestView] = useState(false);
  const items = schedule.filter((item) => !guestView || !item.teamOnly);

  return (
    <>
      <PageHeader
        page="timeline"
        action={
          <>
            <Button variant="secondary" onClick={() => setGuestView(!guestView)} icon="eye">
              {guestView ? "Planner view" : "Guest view"}
            </Button>
            <Button icon="plus">Add schedule item</Button>
          </>
        }
      />
      {guestView && (
        <div className="guest-view-banner">
          <Icon name="eye" /> You’re previewing the guest view. Private notes and vendor-only items
          are hidden.
        </div>
      )}
      <Card className="timeline-card">
        <div className="timeline-date">
          <div>
            <small>SATURDAY</small>
            <strong>20</strong>
            <span>September 2025</span>
          </div>
          <p>
            <b>Maya & Eli’s Wedding Day</b>The Willow House · Portland, Oregon
          </p>
        </div>
        <div className="timeline-list">
          {items.map((item, i) => (
            <div className="timeline-item" key={item.title}>
              <time>{item.time}</time>
              <div className={`timeline-dot ${i === 1 ? "active" : ""}`} />
              <div className="timeline-detail">
                <b>{item.title}</b>
                <span>
                  <Icon name="users" size={14} />
                  {item.audience} · {item.place}
                </span>
              </div>
              <button className="icon-btn" aria-label="More options">
                <Icon name="more" />
              </button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
