export interface EventFormValues {
  name: string;
  template_id: string;
  event_date: string;
  venue: string;
  total_budget: string;
}
export type EventField = keyof EventFormValues;
export type EventFieldErrors = Partial<Record<EventField, string>>;

export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function eventDateError(value: string, today = localToday(), required = true): string | undefined {
  if (!value) return required ? "Event date is required." : undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    return "Enter a valid event date.";
  }
  if (value < today) return "Event date cannot be in the past.";
}

export function validateEventForm(draft: EventFormValues, requireTemplate: boolean, today = localToday()): EventFieldErrors {
  const errors: EventFieldErrors = {};
  if (!draft.name.trim()) errors.name = "Event name is required.";
  else if ([...draft.name].length > 150) errors.name = "Use 150 characters or fewer.";
  if (!draft.template_id && requireTemplate) errors.template_id = "Please select an event type.";
  else if (draft.template_id && (!/^[1-9][0-9]{0,19}$/.test(draft.template_id) || BigInt(draft.template_id) > 18446744073709551615n)) errors.template_id = "Please select a valid event type.";
  const date = eventDateError(draft.event_date, today);
  if (date) errors.event_date = date;
  if ([...draft.venue].length > 255) errors.venue = "Use 255 characters or fewer.";
  if (!draft.total_budget.trim()) errors.total_budget = "Total budget is required.";
  else if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(draft.total_budget.trim())) errors.total_budget = "Enter an amount of 0 or more, with up to 2 decimals.";
  return errors;
}

// Map only known API validation messages; never render arbitrary database/server text.
export function apiFieldErrors(message: unknown): EventFieldErrors {
  if (typeof message !== "string") return {};
  if (message === "name is required and must contain at most 150 characters") return { name: "Enter an event name with at most 150 characters." };
  if (message === "venue must contain at most 255 characters or be null") return { venue: "Use 255 characters or fewer." };
  if (message === "total_budget must be between 0 and 9999999999.99 with at most two decimal places") return { total_budget: "Enter an amount of 0 or more, with up to 2 decimals." };
  if (["Event date cannot be in the past.", "Event date is required.", "Enter a valid event date."].includes(message)) return { event_date: message };
  if (message === "event_date must be a real calendar date" || message === "event_date must be a valid YYYY-MM-DD date between years 1000 and 9999, or null") return { event_date: "Enter a valid event date." };
  if (["template_id does not exist", "template_id must be a positive integer or null", "template_id must be a positive unsigned BIGINT or null"].includes(message)) return { template_id: "Please select an available event type." };
  if (["Invalid template percentage", "Template allocations must total 100%"].includes(message)) return { template_id: "Budget defaults are unavailable for this event type. Please select another event type." };
  return {};
}
