import { useState } from "react";
import { navGroups } from "../routes/navigation";
import type { Page } from "../types";
import { Icon } from "./ui";
import { useEvents } from "../features/events/EventsContext";
import { eventDate, eventInitials, eventRole } from "../features/events/eventPresentation";
import { useUserProfile } from "../features/auth/hooks/useUserProfile";

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <span />
        <span />
        <span />
      </div>
      <strong>
        Event<span>Wise</span>
      </strong>
    </div>
  );
}

export function Sidebar({
  page,
  setPage,
  open,
  close,
}: {
  page: Page;
  setPage: (p: Page) => void;
  open: boolean;
  close: () => void;
}) {
  const { events, selectedEvent, status, selectEvent, eventDetails, detailsStatus } = useEvents();
  return (
    <>
      {open && <div className="mobile-overlay" onClick={close} />}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <button className="mobile-close" onClick={close} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>
        <div className="event-switcher">
          <div className="event-thumb">{selectedEvent ? eventInitials(eventDetails?.name ?? selectedEvent.name) : "?"}</div>
          <div>
            <label htmlFor="current-event"><small>Current event</small></label>
            <select id="current-event" value={selectedEvent?.event_id ?? ""} disabled={status !== "ready"}
              onChange={(event) => selectEvent(event.target.value)}>
              {!selectedEvent && <option value="">{status === "loading" ? "Loading events..." : status === "error" ? "Events unavailable" : events.length ? "Select an event" : "No events"}</option>}
              {events.map((event) => <option key={event.event_id} value={event.event_id}>{event.event_id === eventDetails?.event_id ? eventDetails.name : event.name}</option>)}
            </select>
            <span>{eventDetails ? eventRole(eventDetails.role) : selectedEvent ? detailsStatus === "loading" ? "Loading role..." : "Event unavailable" : "No event selected"}</span>
          </div>
          <Icon name="down" size={15} />
        </div>
        <nav className="side-nav">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <label>{group.label}</label>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={page === item.id ? "active" : ""}
                  onClick={() => {
                    setPage(item.id);
                    close();
                  }}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="plan-card">
          <div className="mini-spark">
            <Icon name="spark" size={16} />
          </div>
          <b>Planning progress</b>
          <span>Progress information is not available yet.</span>
        </div>
        <div className="side-footer">
          <button>
            <Icon name="users" /> Help center
          </button>
          <button>
            <Icon name="grid" /> Settings
          </button>
        </div>
      </aside>
    </>
  );
}

export function Topbar({
  toggleMenu,
  goAlerts,
  exit,
}: {
  toggleMenu: () => void;
  goAlerts: () => void;
  exit: () => void;
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const { profile, loading } = useUserProfile();
  const { selectedEvent, eventDetails, detailsStatus } = useEvents();
  return (
    <header className="topbar">
      <button className="menu-button" onClick={toggleMenu} aria-label="Open menu">
        <Icon name="menu" />
      </button>
      <div className="top-event">
        <span>{eventDetails?.name ?? (selectedEvent ? detailsStatus === "loading" ? "Loading event..." : "Event unavailable" : "No event selected")}</span>
        <i />
        <b>{eventDetails ? eventDate(eventDetails.event_date) : ""}</b>
      </div>
      <div className="top-actions">
        <button className="search-button">
          <Icon name="search" />
          <span>Search anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <button className="icon-btn notification" onClick={goAlerts} aria-label="Alerts">
          <Icon name="bell" />
          <i />
        </button>
        <div className="profile-wrap">
          <button className="profile" onClick={() => setProfileOpen(!profileOpen)}>
            <span>{loading ? "..." : profile?.initials ?? "?"}</span>
            <div>
              <b>{loading ? "Loading..." : profile?.displayName ?? "Account"}</b>
              <small>{eventDetails ? eventRole(eventDetails.role) : selectedEvent ? detailsStatus === "loading" ? "Loading role..." : "Event unavailable" : "No event selected"}</small>
            </div>
            <Icon name="down" size={14} />
          </button>
          {profileOpen && (
            <div className="profile-menu">
              <button>Account settings</button>
              <button>Event settings</button>
              <button onClick={exit}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
