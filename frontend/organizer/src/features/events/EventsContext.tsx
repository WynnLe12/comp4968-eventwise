import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Hub } from "aws-amplify/utils";
import { EventSessionError, listEvents, type OrganizerEvent } from "./services/eventApi";

type EventState = { events: OrganizerEvent[]; selectedId: string | null; status: "loading" | "ready" | "empty" | "error"; error: string };
const initialState: EventState = { events: [], selectedId: null, status: "loading", error: "" };

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
  const refresh = useCallback(async () => {
    const current = ++version.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState(initialState);
    try {
      const result = await listEvents(controller.signal);
      if (current !== version.current) return;
      const previousId = selection.current?.userId === result.userId ? selection.current.id : null;
      const id = result.events.find((event) => event.event_id === previousId)?.event_id ?? result.events[0]?.event_id ?? null;
      selection.current = { userId: result.userId, id };
      setState({ events: result.events, selectedId: id, status: result.events.length ? "ready" : "empty", error: "" });
    } catch (error) {
      if (current !== version.current) return;
      selection.current = null;
      setState({ ...initialState, status: "error", error: error instanceof EventSessionError
        ? error.message : "Unable to load your events. Please try again." });
      if (error instanceof EventSessionError) sessionExpired.current();
    }
  }, []);
  useEffect(() => {
    const reload = () => { void refresh(); };
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedOut" || payload.event === "tokenRefresh_failure") clear();
      if (payload.event === "signedIn") { clear(); reload(); }
    });
    window.addEventListener("focus", reload);
    reload();
    return () => {
      ++version.current;
      pending.current?.abort();
      selection.current = null;
      unsubscribe();
      window.removeEventListener("focus", reload);
    };
  }, [clear, refresh]);
  // Router callbacks may change between pages; they must not reset event selection.
  useEffect(() => { sessionExpired.current = onSessionExpired; }, [onSessionExpired]);
  const selectEvent = (id: string) => {
    if (state.status !== "ready" || !state.events.some((event) => event.event_id === id)) return;
    if (selection.current) selection.current.id = id;
    setState((previous) => ({ ...previous, selectedId: id }));
  };
  return { ...state, selectedEvent: state.events.find((event) => event.event_id === state.selectedId) ?? null, selectEvent, refresh };
}

const EventsContext = createContext<ReturnType<typeof useEventList> | null>(null);
export function EventsProvider({ children, onSessionExpired }: { children: ReactNode; onSessionExpired: () => void }) {
  const events = useEventList(onSessionExpired);
  return <EventsContext.Provider value={events}>{children}</EventsContext.Provider>;
}
export function useEvents() {
  const events = useContext(EventsContext);
  if (!events) throw new Error("EventsProvider is required");
  return events;
}
