import type { IncomingMessage, ServerResponse } from "node:http";
import { EmailVerificationUnavailableError, InvalidCognitoAccessTokenError, VerifiedEmailRequiredError, type ResolveVerifiedEmail } from "../../shared/auth/verifiedEmail";
import { readJsonBody, RequestError, sendJson } from "../../shared/utils/http";
import { InvitationCreationError, InvitationInactiveError } from "../repositories/invitationRepository";
import { EventAccessDeniedError, EventConflictError, EventNotFoundError, EventValidationError } from "../services/eventService";
import { organizerOriginError, type InvitationService } from "../services/invitationService";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";

export type InvitationOperations = Pick<InvitationService, "create" | "list" | "revoke">;

interface InvitationDependencies extends EventAuthentication {
  invitations: InvitationOperations;
}

const mysqlMessages = new Map([
  ["ER_BAD_FIELD_ERROR", "An expected database column is missing."],
  ["ER_NO_SUCH_TABLE", "An expected database table is missing."],
  ["ER_BAD_DB_ERROR", "The configured database does not exist."],
  ["ER_ACCESS_DENIED_ERROR", "MySQL rejected the application database credentials."],
  ["ER_DBACCESS_DENIED_ERROR", "The application account cannot access the database."],
  ["ER_TABLEACCESS_DENIED_ERROR", "The application account lacks a required MySQL table privilege."],
  ["ER_COLUMNACCESS_DENIED_ERROR", "The application account lacks a required MySQL column privilege."],
  ["ER_SPECIFIC_ACCESS_DENIED_ERROR", "The application account lacks a required MySQL privilege."],
  ["ER_DUP_ENTRY", "An invitation unique constraint rejected a duplicate value."],
  ["ER_NO_REFERENCED_ROW_2", "An invitation foreign key reference is missing."],
  ["ER_DATA_TOO_LONG", "An invitation value exceeds the database column length."],
  ["ER_NO_DEFAULT_FOR_FIELD", "The database requires a value for a column omitted from this statement."],
  ["ER_LOCK_DEADLOCK", "The invitation transaction encountered a MySQL deadlock."],
  ["ER_LOCK_WAIT_TIMEOUT", "The invitation transaction timed out waiting for a MySQL lock."],
  ["ER_PARSE_ERROR", "MySQL rejected the invitation statement syntax."],
]);
const safeMessages = new Set([
  organizerOriginError,
  "Unable to retrieve or parse database secret",
  "Database secret must contain nonempty username and password strings",
  "Created invitation could not be read",
  "Accepted membership could not be read",
  "EVENTS_INVITATION_EMAIL_KEY must be a base64-encoded 32-byte key",
  "Unable to recover invitation email link",
]);
const safeErrorTypes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError"]);
type InvitationOperation = "create" | "list" | "revoke" | "accept" | "dispatch";

function logInvitationFailure(operation: InvitationOperation, error: unknown) {
  const cause = error instanceof InvitationCreationError ? error.cause : error;
  const fields = cause instanceof Error ? cause as Error & { code?: unknown; errno?: unknown } : undefined;
  const mysqlCode = typeof fields?.code === "string" && mysqlMessages.has(fields.code) ? fields.code : undefined;
  const message = typeof fields?.message === "string" ? fields.message : "";
  const step = error instanceof InvitationCreationError ? error.step : message === organizerOriginError ? "organizer-origin" : undefined;
  // Driver messages can embed bound values, credentials and SQL. Emit only
  // reviewed messages and metadata, and never serialize the exception object.
  const errorMessage = safeMessages.has(message) ? message
    : mysqlCode === "ER_BAD_FIELD_ERROR" && /Unknown column ['`]pending_email['`]/i.test(message)
      ? "Unknown column pending_email. Verify migration 002 in the configured database."
      : (mysqlCode ? mysqlMessages.get(mysqlCode) : undefined) ?? "Unrecognized error details omitted.";
  console.error("Event invitation operation failed", {
    operation, step,
    errorType: fields ? safeErrorTypes.has(fields.name) ? fields.name : "Error" : "NonError",
    errorMessage,
    mysqlCode,
    mysqlErrno: typeof fields?.errno === "number" && Number.isInteger(fields.errno) && fields.errno >= 1000 && fields.errno <= 9999
      ? fields.errno : undefined,
  });
}

function invitationError(response: ServerResponse, error: unknown, operation: InvitationOperation) {
  if (error instanceof RequestError) sendJson(response, error.status, { error: error.message });
  else if (error instanceof EventValidationError) sendJson(response, 400, { error: error.message });
  else if (error instanceof InvalidCognitoAccessTokenError) sendJson(response, 401, { error: "Invalid or expired authentication token" });
  else if (error instanceof VerifiedEmailRequiredError) sendJson(response, 403, { error: "A matching verified email is required" });
  else if (error instanceof EventAccessDeniedError) sendJson(response, 403, { error: error.message });
  else if (error instanceof EventNotFoundError) sendJson(response, 404, { error: error.message });
  else if (error instanceof EventConflictError) sendJson(response, 409, { error: error.message });
  else if (error instanceof InvitationInactiveError) sendJson(response, 410, { error: error.message });
  else if (error instanceof EmailVerificationUnavailableError) sendJson(response, 503, { error: "Unable to verify your email right now. Please try again." });
  else {
    logInvitationFailure(operation, error);
    sendJson(response, 500, { error: "Unable to complete invitation request" });
  }
}

export function eventInvitationHandler(dependencies: InvitationDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, eventId: string, invitationId?: string): Promise<void> => {
    const sub = await authenticateEvent(request, response, dependencies);
    if (sub === undefined) return;
    let operation: InvitationOperation = "dispatch";
    try {
      if (request.method === "POST") {
        operation = "create";
        const { email_retry, ...invitation } = await dependencies.invitations.create(eventId, await readJsonBody(request), sub);
        sendJson(response, email_retry ? 200 : 201, invitation, { "Cache-Control": "no-store" });
      } else if (request.method === "GET") {
        operation = "list";
        sendJson(response, 200, await dependencies.invitations.list(eventId, sub));
      } else if (request.method === "DELETE" && invitationId !== undefined) {
        operation = "revoke";
        await dependencies.invitations.revoke(eventId, invitationId, sub);
        response.writeHead(204);
        response.end();
      } else {
        sendJson(response, 404, { error: "Not found" });
      }
    } catch (error) {
      invitationError(response, error, operation);
    }
  };
}

export function acceptInvitationHandler(dependencies: EventAuthentication & {
  acceptance: Pick<InvitationService, "accept">;
  resolveVerifiedEmail: ResolveVerifiedEmail;
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const sub = await authenticateEvent(request, response, dependencies);
    if (sub === undefined) return;
    const accessToken = /^Bearer\s+([^\s,]+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!accessToken) {
      sendJson(response, 401, { error: "Missing or invalid authentication token" });
      return;
    }
    try {
      const result = await dependencies.acceptance.accept(await readJsonBody(request), sub, accessToken, dependencies.resolveVerifiedEmail);
      sendJson(response, 200, result);
    } catch (error) {
      invitationError(response, error, "accept");
    }
  };
}
