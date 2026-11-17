/**
 * Vendor service backed by the deployed Vendors API (docs/api/vendors.md), which reads
 * and writes the vendors table in RDS through the eventwise-vendors Lambda.
 *
 * Every request sends the Cognito access token as `Authorization: Bearer <token>`;
 * API Gateway's authorizer verifies it and the Lambda checks event membership.
 * Error bodies are `{ error: { code, message, fields? } }` and become the error
 * classes below, so the Vendors page handles 403/404/409/422 the same way it did
 * with mock data.
 *
 * The contract-expense helpers (addContractExpense and the "sync" choice on update)
 * still use the in-memory mock expense store until the Expenses API is deployed.
 */
import { requireAuthSession } from "../features/auth/services/authService";
import type {
  Vendor,
  VendorCreateInput,
  VendorFieldErrors,
  VendorUpdateInput,
} from "../types";
import { apiUrl } from "./apiConfig";
import { addContractExpense, syncContractExpense } from "./vendorExpenseContract";
import type { VendorDeleteConflict } from "./vendorRules";

export type { VendorDeleteConflict } from "./vendorRules";

/** Any non-2xx response. `code` is the API's `error.code` (absent for API Gateway's 401). */
export class VendorServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VendorServiceError";
  }
}

/** 422 VALIDATION_ERROR: `fields` maps each invalid field to the message shown under it. */
export class VendorValidationError extends VendorServiceError {
  constructor(
    message: string,
    public readonly fields: VendorFieldErrors,
  ) {
    super(message, 422, "VALIDATION_ERROR");
    this.name = "VendorValidationError";
  }
}

/** 409 SIGNED_CONTRACT or HAS_EXPENSES from DELETE. */
export class VendorDeleteConflictError extends VendorServiceError {
  constructor(
    message: string,
    public readonly conflict: VendorDeleteConflict,
  ) {
    super(message, 409, conflict);
    this.name = "VendorDeleteConflictError";
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface ApiErrorBody {
  error?: { code?: string; message?: string; fields?: VendorFieldErrors };
}

/** Friendlier text for statuses whose server message is terse or missing. */
const STATUS_MESSAGES: Record<number, string> = {
  401: "Your session has expired. Please sign in again.",
  403: "You don't have access to this event.",
  404: "This vendor no longer exists.",
  500: "Something went wrong. Please try again.",
};

async function accessToken(): Promise<string> {
  try {
    const { session } = await requireAuthSession();
    const token = session.tokens?.accessToken;
    if (token) return token.toString();
  } catch {
    // Fall through to the same 401 the API would return.
  }
  throw new VendorServiceError(STATUS_MESSAGES[401]!, 401);
}

/** Path segments are numeric IDs; encode anyway so a bad value can't change the route. */
function vendorsPath(eventId: string, vendorId?: string) {
  const base = `/events/${encodeURIComponent(eventId)}/vendors`;
  return vendorId === undefined ? base : `${base}/${encodeURIComponent(vendorId)}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new VendorServiceError("We couldn't reach the server. Check your connection and try again.", 0);
  }

  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return json as T;

  const error = (json as ApiErrorBody | null)?.error ?? {};
  const message =
    (response.status === 422 || response.status === 409) && error.message
      ? error.message
      : (STATUS_MESSAGES[response.status] ?? error.message ?? STATUS_MESSAGES[500]!);

  if (response.status === 422) {
    throw new VendorValidationError(message, error.fields ?? {});
  }
  if (response.status === 409 && (error.code === "SIGNED_CONTRACT" || error.code === "HAS_EXPENSES")) {
    throw new VendorDeleteConflictError(message, error.code);
  }
  throw new VendorServiceError(message, response.status, error.code);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const vendorService = {
  /** GET /events/{eventId}/vendors -> 200, sorted by name. */
  list: (eventId: string) => request<Vendor[]>("GET", vendorsPath(eventId)),

  /** GET /events/{eventId}/vendors/{vendorId} -> 200. */
  get: (eventId: string, vendorId: string) =>
    request<Vendor>("GET", vendorsPath(eventId, vendorId)),

  /** POST /events/{eventId}/vendors -> 201. The event comes from the URL, never the body. */
  create: (eventId: string, input: VendorCreateInput) =>
    request<Vendor>("POST", vendorsPath(eventId), input),

  /** PATCH /events/{eventId}/vendors/{vendorId} with only the changed fields -> 200. */
  update: async (
    eventId: string,
    vendorId: string,
    input: VendorUpdateInput,
    expenseChoice: "keep" | "sync" = "keep",
  ) => {
    const before = expenseChoice === "sync" ? await vendorService.get(eventId, vendorId) : null;
    const updated = await request<Vendor>("PATCH", vendorsPath(eventId, vendorId), input);
    if (before && updated.contractTotal !== null) {
      // TODO(expenses-api): await the real expense PATCH here, then reread the vendor so
      // paidTotal/balance/nextDueDate reflect it. If the expense update fails after the
      // vendor PATCH succeeded, tell the user the vendor saved but the expense didn't.
      syncContractExpense(before, updated.contractTotal);
    }
    return updated;
  },

  /** Adds the vendor's contract as an expense (mock store for now), then rereads the vendor. */
  addContractExpense: async (eventId: string, vendorId: string) => {
    // TODO(expenses-api): await the real expense POST (addContractExpense becomes async).
    addContractExpense(await vendorService.get(eventId, vendorId));
    return vendorService.get(eventId, vendorId);
  },

  /** DELETE /events/{eventId}/vendors/{vendorId} -> 204. */
  remove: (eventId: string, vendorId: string) =>
    request<void>("DELETE", vendorsPath(eventId, vendorId)),
};
