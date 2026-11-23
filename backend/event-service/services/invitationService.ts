import { createHash, randomBytes, randomUUID } from "node:crypto";
import { VerifiedEmailRequiredError, type ResolveVerifiedEmail } from "../../shared/auth/verifiedEmail";
import { normalizeInvitationEmail } from "../invitationEmail";
import { InvitationRepository } from "../repositories/invitationRepository";
import { EventValidationError, validateEventId } from "./eventService";
import { createInvitationEmailPublisher, invitationEmailKey, openInvitationUrl, sealInvitationUrl, type PublishInvitationEmail } from "./invitationEmailPublisher";

const publishInvitationEmail = createInvitationEmailPublisher();

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

export const organizerOriginError = "Events organizer origin must be a valid HTTPS origin or an HTTP origin on localhost or 127.0.0.1";

function organizerOrigin(value: string | undefined): string {
  try {
    const configured = value?.trim() ?? "";
    const origin = /^(https?):\/\/([^/?#@\\%\s\x00-\x1f\x7f]+)\/?$/i.exec(configured);
    if (!origin || origin[2].endsWith(":")) throw new Error();
    // Check the literal authority before URL parsing can normalize IPv4 aliases.
    if (origin[1].toLowerCase() === "http" && !/^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/i.test(origin[2])) throw new Error();
    return new URL(configured).origin;
  } catch {
    throw new Error(organizerOriginError);
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
    private readonly repository: Pick<InvitationRepository, "create" | "list" | "revoke" | "finishEmail"> &
      Partial<Pick<InvitationRepository, "accept">> = new InvitationRepository(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly publishEmail: PublishInvitationEmail = publishInvitationEmail,
  ) {}

  async create(eventId: string, body: unknown, sub: string) {
    const id = validateEventId(eventId);
    const email = invitationEmail(body);
    const origin = organizerOrigin(this.env.EVENTS_ORGANIZER_ORIGIN);
    const queueUrl = this.env.EVENTS_INVITATION_QUEUE_URL?.trim();
    const key = queueUrl ? invitationEmailKey(this.env.EVENTS_INVITATION_EMAIL_KEY) : undefined;
    const scope = `${id}:${email}`;
    let acceptanceUrl: string | undefined;
    const { delivery, ...invitation } = await this.repository.create(id, sub, email, () => {
      const url = new URL("/accept-invitation", origin);
      const token = randomBytes(32).toString("base64url");
      url.hash = new URLSearchParams({ token }).toString();
      acceptanceUrl = url.href;
      return {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        envelope: key ? sealInvitationUrl(acceptanceUrl, key, scope) : undefined,
      };
    }, key ? randomUUID() : undefined);

    let emailStatus: "not_configured" | "queued" | "retryable" = "not_configured";
    if (delivery && queueUrl && key) {
      emailStatus = "retryable";
      try {
        acceptanceUrl ??= openInvitationUrl(delivery.envelope, key, scope);
        await this.publishEmail(queueUrl, { to: invitation.email, eventName: delivery.eventName, invitationUrl: acceptanceUrl });
        emailStatus = "queued";
      } catch {
        console.warn("Invitation email could not be queued");
      } finally {
        try {
          await this.repository.finishEmail(invitation.invitation_id, delivery.claimId, emailStatus === "queued");
        } catch {
          console.warn("Invitation email queue result could not be recorded");
        }
      }
    }
    if (!acceptanceUrl) throw new Error("Unable to recover invitation email link");
    return { ...invitation, acceptance_url: acceptanceUrl, email_status: emailStatus, email_retry: delivery?.retry ?? false };
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
