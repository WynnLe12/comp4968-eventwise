import { EventRepository, InvalidTemplateError, type EventInput, type EventRecord, type ListedEvent } from "../repositories/eventRepository";

export class EventValidationError extends Error {}

function invalid(message: string): never {
  throw new EventValidationError(message);
}

export function validateEventInput(body: unknown): EventInput {
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
    if (typeof eventDate !== "string" || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(eventDate)) {
      invalid("event_date must be a valid YYYY-MM-DD date between years 1000 and 9999, or null");
    }
    const date = new Date(`${eventDate}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== eventDate) {
      invalid("event_date must be a real calendar date");
    }
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

export class EventService {
  constructor(private readonly repository: Pick<EventRepository, "create"> & Partial<Pick<EventRepository, "list">> = new EventRepository()) {}

  async list(cognitoSub: string): Promise<ListedEvent[]> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    if (!this.repository.list) throw new Error("Event listing repository is not configured");
    return this.repository.list(cognitoSub);
  }

  async create(body: unknown, cognitoSub: string): Promise<EventRecord> {
    if (!cognitoSub || cognitoSub.length > 128) throw new Error("Verified Cognito identity is required");
    const input = validateEventInput(body);
    try {
      return await this.repository.create(input, cognitoSub);
    } catch (error) {
      if (error instanceof InvalidTemplateError) throw new EventValidationError(error.message);
      throw error;
    }
  }
}
