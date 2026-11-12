import { useEffect, useRef, useState } from "react";
import { Hub } from "aws-amplify/utils";
import { createEvent, EventCreateError, EventSessionError, EventValidationError, type CreateEventResult } from "../services/eventApi";

export interface CreateEventCallbacks {
  onCreated: (result: CreateEventResult) => Promise<boolean>;
  onComplete: () => void;
  onSessionExpired: () => void;
  onClose: () => void;
}

export function useCreateEvent(options: CreateEventCallbacks) {
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const committed = useRef<CreateEventResult | null>(null);
  const controller = useRef<AbortController | null>(null);
  const version = useRef(0);
  const callbacks = useRef(options);
  useEffect(() => { callbacks.current = options; }, [options]);
  useEffect(() => {
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (["signedIn", "signedOut", "tokenRefresh_failure"].includes(payload.event)) {
        ++version.current;
        controller.current?.abort();
        callbacks.current.onClose();
      }
    });
    return () => { ++version.current; controller.current?.abort(); unsubscribe(); };
  }, []);

  const submit = async (body: unknown) => {
    if (pending.current) return;
    pending.current = true;
    const current = version.current;
    controller.current = new AbortController();
    setLoading(true);
    setError("");
    try {
      // Once POST succeeds, retries must reload/select its result, never POST again.
      if (!committed.current) {
        const result = await createEvent(body, controller.current.signal);
        if (current !== version.current) return;
        committed.current = result;
        setCreated(true);
      }
      const selected = await callbacks.current.onCreated(committed.current);
      if (current !== version.current) return;
      if (!selected) throw new EventCreateError("Your event was created, but the event list could not be refreshed. Retry loading your event.");
      callbacks.current.onComplete();
    } catch (failure) {
      if (current !== version.current) return;
      if (failure instanceof EventSessionError) callbacks.current.onSessionExpired();
      setError(failure instanceof EventValidationError || failure instanceof EventCreateError || failure instanceof EventSessionError
        ? failure.message : "Unable to complete the request. Check your connection and event list before retrying.");
    } finally {
      pending.current = false;
      if (current === version.current) setLoading(false);
    }
  };
  return { loading, created, error, submit, close: () => { if (!pending.current) callbacks.current.onClose(); } };
}
