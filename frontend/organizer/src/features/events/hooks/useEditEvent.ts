import { useEffect, useRef, useState } from "react";
import { Hub } from "aws-amplify/utils";
import { buildEventPatch, EventSessionError, EventUpdateError, EventValidationError, updateEvent,
  type EventEditDraft, type OrganizerEvent, type UpdateEventResult } from "../services/eventApi";

export interface EditEventCallbacks {
  userId: string;
  isCurrent: () => boolean;
  onUpdated: (result: UpdateEventResult) => Promise<boolean>;
  onComplete: () => void;
  onClose: () => void;
  onSessionExpired: () => void;
}

export function useEditEvent(original: OrganizerEvent, options: EditEventCallbacks) {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const committed = useRef<UpdateEventResult | null>(null);
  const version = useRef(0);
  const controller = useRef<AbortController | null>(null);
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

  const submit = async (draft: EventEditDraft) => {
    if (pending.current || blocked) return;
    if (!callbacks.current.isCurrent()) { callbacks.current.onClose(); return; }
    pending.current = true;
    const current = version.current;
    setLoading(true);
    setError("");
    controller.current = new AbortController();
    try {
      if (original.role !== "OWNER") throw new EventUpdateError(403, "Only the event owner can edit this event.");
      if (!committed.current) {
        const patch = buildEventPatch(original, draft);
        if (!Object.keys(patch).length) throw new EventValidationError("No changes to save.");
        const result = await updateEvent(original.event_id, patch, controller.current.signal, callbacks.current.userId);
        if (current !== version.current || !callbacks.current.isCurrent()) return;
        committed.current = result;
        setSaved(true);
      }
      const refreshed = await callbacks.current.onUpdated(committed.current);
      if (current !== version.current || !callbacks.current.isCurrent()) return;
      if (!refreshed) throw new EventUpdateError(503, "Your changes were saved, but the event list could not be refreshed. Retry loading the event.");
      callbacks.current.onComplete();
    } catch (failure) {
      if (current !== version.current || !callbacks.current.isCurrent()) return;
      if (failure instanceof EventSessionError) callbacks.current.onSessionExpired();
      if (failure instanceof EventUpdateError && (failure.status === 403 || failure.status === 404)) setBlocked(true);
      if (failure instanceof EventUpdateError && failure.fieldErrors && Object.values(failure.fieldErrors).some(Boolean)) return failure.fieldErrors;
      setError(failure instanceof EventValidationError || failure instanceof EventUpdateError || failure instanceof EventSessionError
        ? failure.message : "Unable to complete the request. Check your connection and refresh the event before retrying.");
    } finally {
      pending.current = false;
      if (current === version.current) setLoading(false);
    }
  };
  return { loading, saved, blocked, error, submit, close: () => { if (!pending.current) { setError(""); callbacks.current.onClose(); } } };
}
