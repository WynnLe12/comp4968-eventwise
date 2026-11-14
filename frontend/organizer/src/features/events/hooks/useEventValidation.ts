import { useState } from "react";
import type { EventField, EventFieldErrors, EventFormValues } from "../utils/eventFormValidation";

const cleanState = () => ({ attempted: false, errors: {} as EventFieldErrors });

// Show validation only after Submit/Save; then revalidate fields as they change.
export function useEventValidation(validate: (draft: EventFormValues) => EventFieldErrors) {
  const [state, setState] = useState(cleanState);
  const blur = (field: EventField, draft: EventFormValues) => setState((current) => current.attempted ? {
    ...current, errors: { ...current.errors, [field]: validate(draft)[field] },
  } : current);
  return {
    errors: state.errors,
    showSummary: state.attempted && Object.values(state.errors).some(Boolean),
    blur,
    change: blur,
    check: (draft: EventFormValues) => {
      const errors = validate(draft);
      const invalid = Object.values(errors).some(Boolean);
      setState({ attempted: true, errors });
      return !invalid;
    },
    serverErrors: (errors: EventFieldErrors) => setState((current) => ({ ...current, attempted: true, errors: { ...current.errors, ...errors } })),
    reset: () => setState(cleanState()),
  };
}
