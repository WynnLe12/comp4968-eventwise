import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Hub } from "aws-amplify/utils";
import { EventSessionError, listEvents, type OrganizerEvent } from "./services/eventApi";

import { EditEventModal } from "./components/EditEventModal";
import { useEventDetails } from "./hooks/useEventDetails";

type EventState = { userId: string | null; events: OrganizerEvent[]; selectedId: string | null; status: "loading" | "ready" | "empty" | "error"; error: string };
const initialState: EventState = { userId: null, events: [], selectedId: null, status: "loading", error: "" };

const selectedEventKey = (userId: string) => `eventwise:selected-event:${userId}`;

function readSelectedEvent(userId: string): string | null {
  try {
    return window.sessionStorage.getItem(selectedEventKey(userId));
  } catch {
    return null;
  }
}

function rememberSelectedEvent(userId: string, eventId: string | null) {
  try {
    if (eventId) {
      window.sessionStorage.setItem(selectedEventKey(userId), eventId);
    } else {
      window.sessionStorage.removeItem(selectedEventKey(userId));
    }
  } catch {
    // Selection still works if browser storage is unavailable.
  }
}

export function useEventList(onSessionExpired: () => void) {
  const [state, setState] = useState<EventState>(initialState);
  const selection = useRef<{ userId: string; id: string | null } | null>(null);
  const version = useRef(0);
  const sessionExpired = useRef(onSessionExpired);
  const pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    ++version.current;
    pending.current?.abort();
    selection.current = null;
    setState({ ...initialState, status: "empty" });
  }, []);
  const refresh = useCallback(async (
    preferred?: { userId: string; id: string },
    background = false
  ): Promise<boolean> => {
    const current = ++version.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;

    // Background refresh preserves the current event and open forms.
    // Manual refresh keeps Wynn's original loading behavior.
    if (background) {
      setState((previous) =>
        previous.status === "ready"
          ? previous
          : { ...previous, status: "loading", error: "" }
      );
    } else {
      setState(initialState);
    }

    try {
      const result = await listEvents(controller.signal);
      if (current !== version.current) return false;
      const preferredId = preferred?.userId === result.userId ? preferred.id : null;
      const previousId = preferredId ?? (selection.current?.userId === result.userId ? selection.current.id : null) ?? readSelectedEvent(result.userId);
      const id = result.events.find((event) => event.event_id === previousId)?.event_id ?? result.events[0]?.event_id ?? null;
      selection.current = { userId: result.userId, id };
      rememberSelectedEvent(result.userId, id);
      setState({ userId: result.userId, events: result.events, selectedId: id, status: result.events.length ? "ready" : "empty", error: "" });
      return !preferred || (preferred.userId === result.userId && id === preferred.id);
    } catch (error) {
      if (current !== version.current) return false;
      selection.current = null;
      setState({
        ...initialState, status: "error", error: error instanceof EventSessionError
          ? error.message : "Unable to load your events. Please try again."
      });
      if (error instanceof EventSessionError) sessionExpired.current();
      return false;
    }
  }, []);
  useEffect(() => {
    const reload = () => { void refresh(); };
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedOut" || payload.event === "tokenRefresh_failure") clear();
      if (payload.event === "signedIn") { clear(); reload(); }
    });
    const refreshOnFocus = () => {
      void refresh(undefined, true);
    };

    window.addEventListener("focus", refreshOnFocus);
    reload();
    return () => {
      ++version.current;
      pending.current?.abort();
      selection.current = null;
      unsubscribe();
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [clear, refresh]);
  // Router callbacks may change between pages; they must not reset event selection.
  useEffect(() => { sessionExpired.current = onSessionExpired; }, [onSessionExpired]);
  const selectEvent = (id: string) => {
    if (state.status !== "ready" || !state.events.some((event) => event.event_id === id)) return;
    if (selection.current) selection.current.id = id;
    if (state.userId) rememberSelectedEvent(state.userId, id);
    setState((previous) => ({ ...previous, selectedId: id }));
  };
  const isCurrentEvent = useCallback((userId: string, id: string) => selection.current?.userId === userId && selection.current.id === id, []);
  return { isCurrentEvent, expireSession: () => sessionExpired.current(), ...state, selectedEvent: state.events.find((event) => event.event_id === state.selectedId) ?? null, selectEvent, refresh };
}

const EventsContext = createContext<(ReturnType<typeof useEventList> & ReturnType<typeof useEventDetails> & { openCreate: () => void; openEdit: () => void }) | null>(null);
export function EventsProvider({ children, onSessionExpired, onCreate }: { children: ReactNode; onSessionExpired: () => void; onCreate: () => void }) {
  const events = useEventList(onSessionExpired);
  const details = useEventDetails(events.selectedId, events.userId, onSessionExpired);
  const [editing, setEditing] = useState<{ userId: string; event: OrganizerEvent } | null>(null);
  const visible = editing && events.isCurrentEvent(editing.userId, editing.event.event_id)
    && (!details.eventDetails || details.eventDetails.role === "OWNER");
  useEffect(() => { if (editing && !visible) setEditing(null); }, [editing, visible]);
  const openEdit = () => {
    if (events.userId && details.eventDetails?.role === "OWNER") {
      setEditing({ userId: events.userId, event: details.eventDetails });
    }
  };
  return <EventsContext.Provider value={{ ...events, ...details, openCreate: onCreate, openEdit }}>
    {children}
    {editing && visible && <EditEventModal
      key={`${editing.userId}/${editing.event.event_id}`} event={editing.event} userId={editing.userId}
      isCurrent={() => events.isCurrentEvent(editing.userId, editing.event.event_id)}
      onClose={() => setEditing(null)} onComplete={() => setEditing(null)} onSessionExpired={onSessionExpired}
      onUpdated={async (result) => {
        if (!events.isCurrentEvent(editing.userId, editing.event.event_id) || result.userId !== editing.userId) return false;
        const refreshed = await events.refresh({ userId: editing.userId, id: editing.event.event_id });
        if (refreshed && events.isCurrentEvent(editing.userId, editing.event.event_id)) details.reloadDetails();
        return refreshed;
      }}
    />}
  </EventsContext.Provider>;
}
export function useEvents() {
  const events = useContext(EventsContext);
  if (!events) throw new Error("EventsProvider is required");
  return events;
}
