import { getCurrentUser, requireAuthSession } from "../../auth/services/authService";

export interface OrganizerEvent {
  event_id: string;
  template_id: string | null;
  name: string;
  event_date: string | null;
  venue: string | null;
  total_budget: string;
  created_at: string;
  updated_at: string;
  role: "OWNER" | "CO_PLANNER";
}

export class EventSessionError extends Error {}
export class EventDetailsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function authenticatedEventRequest() {
  let identity: Awaited<ReturnType<typeof requireAuthSession>>;
  try { identity = await requireAuthSession(); }
  catch { throw new EventSessionError("Your session has expired. Please sign in again."); }
  const token = identity.session.tokens?.accessToken;
  if (!token) throw new EventSessionError("Please sign in again.");
  return { ...identity, token };
}

export type CreatedEvent = Omit<OrganizerEvent, "role">;
export interface CreateEventResult { userId: string; event: CreatedEvent }
export interface CreateEventInput {
  name: string;
  template_id?: string | null;
  event_date?: string | null;
  venue?: string | null;
  total_budget?: string;
}
export class EventValidationError extends Error {}
export class EventCreateError extends Error {}

export function validateCreateEvent(body: unknown): CreateEventInput {
  const invalid = (message: string): never => { throw new EventValidationError(message); };
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Enter your event details.");
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["name", "template_id", "event_date", "venue", "total_budget"].includes(key))) {
    return invalid("Unsupported event field.");
  }
  if (typeof fields.name !== "string" || !fields.name.trim() || [...fields.name].length > 150) {
    return invalid("Enter an event name with at most 150 characters.");
  }
  const template = fields.template_id ?? null;
  if (template !== null && (typeof template !== "string" || !/^[1-9][0-9]{0,19}$/.test(template) || BigInt(template) > 18446744073709551615n)) {
    return invalid("Enter a valid existing template ID or create without a template.");
  }
  const date = fields.event_date ?? null;
  if (date !== null) {
    if (typeof date !== "string" || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(date)) return invalid("Enter an event date in YYYY-MM-DD format (years 1000-9999).");
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return invalid("Enter a real calendar date.");
  }
  const venue = fields.venue ?? null;
  if (venue !== null && (typeof venue !== "string" || [...venue].length > 255)) return invalid("Venue must contain at most 255 characters.");
  if (fields.total_budget !== undefined && (typeof fields.total_budget !== "string" || !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(fields.total_budget))) {
    return invalid("Budget must be between 0 and 9999999999.99 with at most two decimal places.");
  }
  return { name: fields.name.trim(), template_id: template, event_date: date, venue,
    ...(fields.total_budget === undefined ? {} : { total_budget: fields.total_budget }) };
}

function parseEvent(row: unknown): CreatedEvent {
  if (!row || typeof row !== "object") throw new Error("The event service returned an invalid event.");
  const event = row as Record<string, unknown>;
  if (typeof event.event_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(event.event_id)
    || BigInt(event.event_id) > 18446744073709551615n || typeof event.name !== "string"
    || (event.template_id !== null && typeof event.template_id !== "string")
    || (event.event_date !== null && typeof event.event_date !== "string")
    || (event.venue !== null && typeof event.venue !== "string")
    || typeof event.total_budget !== "string" || !/^[0-9]+\.[0-9]{2}$/.test(event.total_budget)
    || typeof event.created_at !== "string" || typeof event.updated_at !== "string") {
    throw new Error("The event service returned an invalid event.");
  }
  return { event_id: event.event_id, template_id: event.template_id, name: event.name,
    event_date: event.event_date, venue: event.venue, total_budget: event.total_budget,
    created_at: event.created_at, updated_at: event.updated_at };
}

export function parseEvents(body: unknown): OrganizerEvent[] {
  if (!Array.isArray(body)) throw new Error("The event service returned an invalid response.");
  return body.map((row: unknown) => {
    const event = parseEvent(row);
    const role = (row as Record<string, unknown>).role;
    if (role !== "OWNER" && role !== "CO_PLANNER") throw new Error("The event service returned an invalid event.");
    return { ...event, role };
  });
}

export async function createEvent(body: unknown, signal?: AbortSignal): Promise<CreateEventResult> {
  const payload = validateCreateEvent(body);
  const identity = await authenticatedEventRequest();
  const { token } = identity;
  const response = await fetch("/api/events", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.toString()}` },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (response.status === 400) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new EventCreateError(error?.error === "template_id does not exist"
      ? "That template does not exist. Check its ID or create without a template."
      : "Check your event details and try again.");
  }
  if (response.status !== 201) throw new EventCreateError("Unable to create your event. Please try again.");
  const event = parseEvent(await response.json());
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  if (current.userId !== identity.user.userId) throw new EventCreateError("Your account changed. Reload your events before creating another.");
  return { userId: current.userId, event };
}

export async function listEvents(signal?: AbortSignal): Promise<{ userId: string; events: OrganizerEvent[] }> {
  const identity = await authenticatedEventRequest();
  const { token } = identity;
  const response = await fetch("/api/events", {
    headers: { Authorization: `Bearer ${token.toString()}` }, signal,
  });
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (!response.ok) throw new Error("Unable to load your events. Please try again.");
  const events = parseEvents(await response.json());
  // Discard data if the account changed while the request was in flight.
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  if (current.userId !== identity.user.userId) throw new Error("Your account changed. Please reload your events.");
  return { userId: current.userId, events };
}


export async function getEventDetails(eventId: string, signal?: AbortSignal): Promise<{ userId: string; event: OrganizerEvent }> {
  let id: string;
  try { id = requestEventId(eventId); }
  catch { throw new EventDetailsError(400, "Select a valid event."); }
  const identity = await authenticatedEventRequest();
  const response = await fetch(`/api/events/${id}`, {
    headers: { Authorization: `Bearer ${identity.token.toString()}` }, signal,
  });
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (response.status === 403) throw new EventDetailsError(403, "You no longer have access to this event. Select another event or refresh your event list.");
  if (response.status === 404) throw new EventDetailsError(404, "This event no longer exists. Select another event or refresh your event list.");
  if (!response.ok) throw new EventDetailsError(response.status, "Unable to load event details. Please try again.");
  // GET by ID returns a single event with the requesting user's membership role.
  const event = parseEvents([await response.json()])[0];
  if (event.event_id !== id) throw new EventDetailsError(502, "Unable to load event details. Please try again.");
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  if (current.userId !== identity.user.userId) throw new EventDetailsError(409, "Your account changed. Please reload your events.");
  return { userId: current.userId, event };
}


function requestEventId(eventId: string): string {
  if (typeof eventId !== "string" || !/^[0-9]+$/.test(eventId)) throw new EventValidationError("Select a valid event.");
  const id = eventId.replace(/^0+/, "");
  if (!id || id.length > 20 || BigInt(id) > 18446744073709551615n) throw new EventValidationError("Select a valid event.");
  return id;
}

export type EventPatch = Partial<CreateEventInput>;
export type EventEditDraft = Record<keyof CreateEventInput, string>;
export interface UpdateEventResult { userId: string; event: OrganizerEvent }
export class EventUpdateError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function eventEditDraft(event: OrganizerEvent): EventEditDraft {
  return { name: event.name, template_id: event.template_id ?? "", event_date: event.event_date ?? "", venue: event.venue ?? "", total_budget: event.total_budget };
}

export function validateEventPatch(body: unknown): EventPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new EventValidationError("Enter the event details to update.");
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (!keys.length) throw new EventValidationError("No changes to save.");
  if (keys.some((key) => fields[key] === undefined)) throw new EventValidationError("Enter a value for each changed field.");
  const validated = validateCreateEvent({ name: "Event", ...fields });
  return Object.fromEntries(keys.map((key) => [key, validated[key as keyof CreateEventInput]]));
}

export function buildEventPatch(original: OrganizerEvent, draft: EventEditDraft): EventPatch {
  const initial = eventEditDraft(original);
  const changed: Record<string, string | null> = {};
  for (const field of ["name", "template_id", "event_date", "venue", "total_budget"] as const) {
    if (draft[field] === initial[field]) continue;
    const value = draft[field].trim();
    changed[field] = ["template_id", "event_date", "venue"].includes(field) && !value ? null : value;
  }
  if (!Object.keys(changed).length) return {};
  const validated = validateEventPatch(changed);
  // Differences in whitespace or decimal formatting alone do not require a write.
  const decimal = (value: string) => { const [whole, fraction = ""] = value.split("."); return `${whole}.${fraction.padEnd(2, "0")}`; };
  return Object.fromEntries(Object.entries(validated).filter(([field, value]) => field === "total_budget"
    ? decimal(value as string) !== decimal(original.total_budget)
    : value !== original[field as keyof CreateEventInput]));
}

export async function updateEvent(eventId: string, body: unknown, signal?: AbortSignal, expectedUserId?: string): Promise<UpdateEventResult> {
  const id = requestEventId(eventId);
  const payload = validateEventPatch(body);
  const identity = await authenticatedEventRequest();
  if (expectedUserId && identity.user.userId !== expectedUserId) throw new EventUpdateError(409, "Your account changed. Please reload your events.");
  const response = await fetch(`/api/events/${id}`, {
    method: "PATCH", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.token.toString()}` },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) throw new EventSessionError("Your session has expired. Please sign in again.");
  if (response.status === 403) throw new EventUpdateError(403, "Only the current event owner can save changes. Close the editor and refresh your events.");
  if (response.status === 404) throw new EventUpdateError(404, "This event no longer exists. Close the editor and refresh your events.");
  if (response.status === 400) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new EventUpdateError(400, error?.error === "template_id does not exist"
      ? "That template does not exist. Check its ID or clear the template field."
      : "Check your changed event details and try again.");
  }
  if (!response.ok) throw new EventUpdateError(response.status, "Unable to save your event. Please try again.");
  const event = parseEvents([await response.json()])[0];
  if (event.event_id !== id) throw new EventUpdateError(502, "Unable to confirm the saved event. Refresh your events before retrying.");
  const current = await getCurrentUser().catch(() => { throw new EventSessionError("Please sign in again."); });
  if (current.userId !== identity.user.userId) throw new EventUpdateError(409, "Your account changed. Please reload your events.");
  return { userId: current.userId, event };
}
