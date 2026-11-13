import { useCallback, useEffect, useRef, useState } from "react";
import { Hub } from "aws-amplify/utils";
import { EventDetailsError, EventSessionError, getEventDetails, type OrganizerEvent } from "../services/eventApi";

type DetailState = { key: string; status: "idle" | "loading" | "ready" | "error"; event: OrganizerEvent | null; error: string; errorStatus: number | null };
const empty: DetailState = { key: "", status: "idle", event: null, error: "", errorStatus: null };

export function useEventDetails(eventId: string | null, userId: string | null, onSessionExpired: () => void) {
  const [state, setState] = useState<DetailState>(empty);
  const [retry, setRetry] = useState(0);
  const version = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const sessionExpired = useRef(onSessionExpired);
  const key = userId && eventId ? `${userId}/${eventId}` : "";
  useEffect(() => { sessionExpired.current = onSessionExpired; }, [onSessionExpired]);
  useEffect(() => {
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (["signedIn", "signedOut", "tokenRefresh_failure"].includes(payload.event)) {
        ++version.current;
        pending.current?.abort();
        setState(empty);
      }
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    const current = ++version.current;
    pending.current?.abort();
    if (!eventId || !userId) { setState(empty); return; }
    const controller = new AbortController();
    pending.current = controller;
    setState({ ...empty, key, status: "loading" });
    void (async () => {
      try {
        const result = await getEventDetails(eventId, controller.signal);
        if (current !== version.current) return;
        if (result.userId !== userId) throw new EventDetailsError(409, "Your account changed. Please reload your events.");
        setState({ ...empty, key, status: "ready", event: result.event });
      } catch (error) {
        if (current !== version.current) return;
        setState({ ...empty, key, status: "error",
          error: error instanceof EventDetailsError || error instanceof EventSessionError ? error.message : "Unable to load event details. Please try again.",
          errorStatus: error instanceof EventDetailsError ? error.status : null });
        if (error instanceof EventSessionError) sessionExpired.current();
      }
    })();
    return () => { ++version.current; controller.abort(); };
  }, [eventId, userId, key, retry]);

  const reloadDetails = useCallback(() => setRetry((value) => value + 1), []);
  // Never expose the last selection's data, even before the new effect runs.
  const active = key && state.key === key;
  return {
    eventDetails: active && state.status === "ready" ? state.event : null,
    detailsStatus: !key ? "idle" : active ? state.status : "loading",
    detailsError: active ? state.error : "",
    detailsErrorStatus: active ? state.errorStatus : null,
    reloadDetails,
  };
}
