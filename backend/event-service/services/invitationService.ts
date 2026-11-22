import { createHash, randomBytes } from "node:crypto";
import { VerifiedEmailRequiredError, type ResolveVerifiedEmail } from "../../shared/auth/verifiedEmail";
import { normalizeInvitationEmail } from "../invitationEmail";
import { InvitationRepository } from "../repositories/invitationRepository";
import { EventValidationError, validateEventId } from "./eventService";

function invitationEmail(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !("email" in body) || typeof body.email !== "string") {
    throw new EventValidationError("Provide an email address");
  }
  const email = normalizeInvitationEmail(body.email);
  if (!email) throw new EventValidationError("Enter a valid email address");
  return email;
}

function invitationToken(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !("token" in body) || typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token) ||
      Buffer.from(body.token, "base64url").toString("base64url") !== body.token) {
    throw new EventValidationError("Enter a valid invitation token");
  }
  return body.token;
}

function organizerOrigin(value: string | undefined): string {
  try {
    const configured = value?.trim() ?? "";
    if (!/^https:\/\/[^/?#@\\\s]+\/?$/i.test(configured)) throw new Error();
    const url = new URL(configured);
    if (url.username || url.password) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Events organizer origin must be a valid HTTPS origin");
  }
}

function validateInvitationId(value: string): string {
  try {
    return validateEventId(value);
  } catch (error) {
    if (!(error instanceof EventValidationError)) throw error;
    throw new EventValidationError(error.message.replace("eventId", "invitationId"));
  }
}

export class InvitationService {
  constructor(
    private readonly repository: Pick<InvitationRepository, "create" | "list" | "revoke"> &
      Partial<Pick<InvitationRepository, "accept">> = new InvitationRepository(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async create(eventId: string, body: unknown, sub: string) {
    const id = validateEventId(eventId);
    const email = invitationEmail(body);
    const url = new URL("/accept-invitation", organizerOrigin(this.env.EVENTS_ORGANIZER_ORIGIN));
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    url.hash = new URLSearchParams({ token }).toString();
    const invitation = await this.repository.create(id, sub, email, hash);
    return { ...invitation, acceptance_url: url.href };
  }

  async list(eventId: string, sub: string) {
    return this.repository.list(validateEventId(eventId), sub);
  }

  async revoke(eventId: string, invitationId: string, sub: string) {
    await this.repository.revoke(validateEventId(eventId), validateInvitationId(invitationId), sub);
  }

  async accept(body: unknown, sub: string, accessToken: string, resolveVerifiedEmail: ResolveVerifiedEmail) {
    const token = invitationToken(body);
    const hash = createHash("sha256").update(token).digest("hex");
    const email = normalizeInvitationEmail(await resolveVerifiedEmail(accessToken, sub));
    if (!email) throw new VerifiedEmailRequiredError("A matching verified email is required");
    if (!this.repository.accept) throw new Error("Invitation acceptance repository is not configured");
    return this.repository.accept(hash, sub, email);
  }
}
