import { EventRepository, EventDeletionBlockedError, InvalidTemplateError, type EventInput, type EventRecord, type ListedEvent } from "../repositories/eventRepository";
import { localToday, validDate } from "../../shared/utils/dateOnly";
import { GuestRepository } from "../../guest-service/repositories/guestRepository";

export class EventValidationError extends Error {}
export class EventNotFoundError extends Error {}
export class EventAccessDeniedError extends Error {}
export class EventConflictError extends Error {}

export function validateEventId(eventId: unknown): string {
  if (typeof eventId !== "string" || !/^[0-9]+$/.test(eventId)) {
    throw new EventValidationError("eventId must be a positive unsigned BIGINT");
  }
  const normalized = eventId.replace(/^0+/, "");
  if (!normalized || normalized.length > 20 || BigInt(normalized) > 18446744073709551615n) {
    throw new EventValidationError("eventId must be between 1 and 18446744073709551615");
  }
  return normalized;
}

function invalid(message: string): never {
  throw new EventValidationError(message);
}

export function validateEventInput(body: unknown, today = localToday()): EventInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const allowed = new Set(["name", "template_id", "event_date", "venue", "total_budget"]);
  if (Object.keys(fields).some((key) => !allowed.has(key))) invalid("Unsupported event property");
  if (typeof fields.name !== "string" || !fields.name.trim() || [...fields.name].length > 150) {
    invalid("name is required and must contain at most 150 characters");
  }
  let templateId: string | null = null;
  if (fields.template_id !== undefined && fields.template_id !== null) {
    const id = fields.template_id;
    if (typeof id !== "string" && (typeof id !== "number" || !Number.isSafeInteger(id))) {
      invalid("template_id must be a positive integer or null");
    }
    const text = String(id);
    if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 18446744073709551615n) {
      invalid("template_id must be a positive unsigned BIGINT or null");
    }
    templateId = text;
  }
  const eventDate = fields.event_date ?? null;
  if (eventDate !== null) {
    if (!validDate(eventDate)) invalid("Enter a valid event date.");
    if (eventDate < today) invalid("Event date cannot be in the past.");
  }
  const venue = fields.venue ?? null;
  if (venue !== null && (typeof venue !== "string" || [...venue].length > 255)) {
    invalid("venue must contain at most 255 characters or be null");
  }
  const budget = fields.total_budget === undefined ? "0.00" : fields.total_budget;
  if ((typeof budget !== "number" && typeof budget !== "string") ||
      !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(String(budget))) {
    invalid("total_budget must be between 0 and 9999999999.99 with at most two decimal places");
  }
  return {
    name: fields.name.trim(), template_id: templateId, event_date: eventDate,
    venue, total_budget: String(budget),
  };
}

export function validateEventPatch(body: unknown, today = localToday()): Partial<EventInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (!keys.length) invalid("At least one event field is required");
  // Reuse creation's schema checks without applying its defaults to omitted fields.
  const validated = validateEventInput({ name: "Event", ...fields }, today);
  return Object.fromEntries(keys.map((key) => [key, validated[key as keyof EventInput]]));
}

export class EventService {
  constructor(private readonly repository: Pick<EventRepository, "create"> & Partial<Pick<EventRepository, "list" | "getById" | "update" | "delete">> = new EventRepository(), private readonly today = localToday,
    private readonly guests: Pick<GuestRepository, "deleteAllForEvent"> = new GuestRepository()) {}

  async delete(eventId: string, cognitoSub: string): Promise<void> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    const id = validateEventId(eventId);
    if (!this.repository.delete) throw new Error("Event delete repository is not configured");
    try {
      await this.repository.delete(id, cognitoSub, (event) => {
        if (!event) throw new EventNotFoundError("Event not found");
        if (event.role !== "OWNER") throw new EventAccessDeniedError("Only the event owner can delete this event");
      });
    } catch (error) {
      if (error instanceof EventDeletionBlockedError) throw new EventConflictError(error.reason === "payments"
        ? "This event has recorded expense payments and cannot be deleted."
        : "This event has records referenced by another event and cannot be deleted.");
      throw error;
    }
    // Guests live in DynamoDB, outside the MySQL cascade. The event is already gone, so a
    // failure here is logged rather than reported: its guests are unreachable (no members).
    try {
      await this.guests.deleteAllForEvent(id);
    } catch (error) {
      console.error(`Event ${id} was deleted, but removing its guests failed:`, error);
    }
  }

  async update(eventId: string, body: unknown, cognitoSub: string): Promise<ListedEvent> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    const id = validateEventId(eventId);
    const patch = validateEventPatch(body, this.today());
    if (!this.repository.update) throw new Error("Event update repository is not configured");
    try {
      const event = await this.repository.update(id, patch, cognitoSub, (current) => {
        if (!current) throw new EventNotFoundError("Event not found");
        if (current.role !== "OWNER") throw new EventAccessDeniedError("Only the event owner can update this event");
        const effectiveDate = patch.event_date === undefined ? current.event_date : patch.event_date;
        if (effectiveDate && effectiveDate < this.today()) invalid("Event date cannot be in the past.");
      });
      return { ...event, role: "OWNER" };
    } catch (error) {
      if (error instanceof InvalidTemplateError) throw new EventValidationError(error.message);
      throw error;
    }
  }

  async getById(eventId: string, cognitoSub: string): Promise<ListedEvent> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    const id = validateEventId(eventId);
    if (!this.repository.getById) throw new Error("Event detail repository is not configured");
    const event = await this.repository.getById(id, cognitoSub);
    if (!event) throw new EventNotFoundError("Event not found");
    if (event.role !== "OWNER" && event.role !== "CO_PLANNER") {
      throw new EventAccessDeniedError("You do not have access to this event");
    }
    return { ...event, role: event.role };
  }

  async list(cognitoSub: string): Promise<ListedEvent[]> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    if (!this.repository.list) throw new Error("Event listing repository is not configured");
    return this.repository.list(cognitoSub);
  }

  async create(body: unknown, cognitoSub: string): Promise<EventRecord> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    const input = validateEventInput(body, this.today());
    try {
      return await this.repository.create(input, cognitoSub);
    } catch (error) {
      if (error instanceof InvalidTemplateError) throw new EventValidationError(error.message);
      throw error;
    }
  }
}
