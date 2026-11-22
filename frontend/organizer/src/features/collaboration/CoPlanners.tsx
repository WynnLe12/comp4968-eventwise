import { useEffect, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../../components/page";
import { Button, Card, Icon } from "../../components/ui";
import { formatCalendarDate } from "../../utils/dateFormat";
import { eventRole } from "../events/eventPresentation";
import { useEvents } from "../events/EventsContext";
import { EventSessionError } from "../events/services/eventApi";
import { EventMembersError, listEventMembers, type EventMember } from "./collaborationApi";

type RosterState = { userId: string; eventId: string } & (
  | { members: EventMember[] }
  | { error: string; denied: boolean }
);

export function CoPlanners() {
  const { selectedEvent, userId, status, openCreate, refresh, expireSession, isCurrentEvent } = useEvents();
  const eventId = selectedEvent?.event_id;
  const [state, setState] = useState<RosterState | null>(null);
  const [retry, setRetry] = useState(0);
  const sessionExpired = useRef(expireSession);
  useEffect(() => { sessionExpired.current = expireSession; }, [expireSession]);

  useEffect(() => {
    setState(null);
    if (!eventId || !userId) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && isCurrentEvent(userId, eventId);

    void (async () => {
      try {
        const members = await listEventMembers(eventId, userId, controller.signal);
        if (isCurrent()) setState({ userId, eventId, members });
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof EventMembersError || error instanceof EventSessionError
          ? error.message : "Unable to load event members. Please try again.";
        setState({ userId, eventId, error: message, denied: error instanceof EventMembersError && error.status === 403 });
        if (error instanceof EventSessionError) sessionExpired.current();
      }
    })();
    return () => controller.abort();
  }, [eventId, userId, isCurrentEvent, retry]);

  const current = state?.eventId === eventId && state?.userId === userId ? state : null;
  let content;
  if (!eventId || !userId) {
    content = <EmptyState
      title="Select an event"
      message={status === "empty" ? "Create an event to see its planning team." : "Choose an event from the event switcher to see its planning team."}
      action={status === "empty" ? <Button onClick={openCreate} icon="plus">Create event</Button> : undefined}
    />;
  } else if (!current) {
    content = <LoadingState label="Loading event members..." />;
  } else if ("error" in current) {
    content = current.denied
      ? <div role="alert"><EmptyState
          title="Event access unavailable"
          message={current.error}
          icon="lock"
          action={<Button variant="secondary" onClick={() => void refresh()}>Refresh events</Button>}
        /></div>
      : <ErrorState message={current.error} onRetry={() => {
          setState(null);
          setRetry(value => value + 1);
        }} />;
  } else if (!current.members.length) {
    content = <EmptyState title="No members yet" message="There are no members to display for this event." icon="users" />;
  } else {
    content = <Card>
      <div className="card-head"><div><h3>Planning team</h3></div></div>
      <ul className="people-list" role="list">
        {current.members.map(member => (
          <li className="person-row" key={member.member_id}>
            <span><Icon name="users" size={16} /></span>
            <div>
              <b>{eventRole(member.role)}{!member.is_self && ` — Member #${member.member_id}`}</b>
              <p>
                {member.is_self && "You · "}
                Joined <time dateTime={member.joined_at}>{formatCalendarDate(member.joined_at.slice(0, 10))}</time>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>;
  }

  return <><PageHeader page="coplanners" />{content}</>;
}
