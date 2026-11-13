export type Page =
  | "dashboard"
  | "events"
  | "coplanners"
  | "budget"
  | "expenses"
  | "vendors"
  | "documents"
  | "guests"
  | "invitations"
  | "alerts"
  | "templates"
  | "tasks"
  | "timeline"
  | "photos"
  | "contracts";

export type PublicPage = "landing" | "signup" | "login" | "reset";

export interface Expense {
  eventId: string;
  vendorId: string | null;
  id: string;
  dueDate?: string | null;
  payments?: ExpensePayment[];
  vendor: string;
  category: string;
  total: number;
  paid: number;
  due: string;
  status: string;
}

export interface ExpensePayment {
  id: string;
  amount: number;
  paidAt: string;
  paymentType: "PAYMENT" | "DEPOSIT";
}

export interface Guest {
  name: string;
  group: string;
  party: number;
  rsvp: string;
  meal: string;
}

// ---------------------------------------------------------------------------
// Vendors: the JSON shape in docs/api/vendors.md (Feature 5 API contract)
// ---------------------------------------------------------------------------

export type BookingStatus = "RESEARCHING" | "QUOTED" | "BOOKED" | "DECLINED";
export type ContractStatus = "NOT_STARTED" | "PENDING" | "SIGNED" | "CANCELLED";

/** Money as the API sends it: a string with exactly 2 decimals ("12800.00"), so DECIMAL values stay exact. */
export type Money = string;

/** The fields a client may send in POST and PATCH. Empty text is null. */
export interface VendorFields {
  name: string;
  category: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  quoteAmount: Money | null;
  contractTotal: Money | null;
  bookingStatus: BookingStatus;
  contractStatus: ContractStatus;
  notes: string | null;
}

export type VendorField = keyof VendorFields;

/** Field name -> message, from a 422 response's `error.fields`. */
export type VendorFieldErrors = Partial<Record<VendorField, string>>;

/**
 * A vendor as the API returns it. IDs are strings of digits; compare them as strings.
 * paidTotal, balance and nextDueDate are calculated by the server from the vendor's
 * expenses; the UI only displays them.
 */
export interface Vendor extends VendorFields {
  id: string;
  eventId: string;
  /** Never null: "0.00" with no payments. */
  paidTotal: Money;
  /** contractTotal - paidTotal; null with no contract total, negative when overpaid. */
  balance: Money | null;
  /** YYYY-MM-DD of the earliest linked expense that isn't fully paid, or null. */
  nextDueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST body: only `name` is required; money may be a string or a number. */
export type VendorCreateInput = Partial<Omit<VendorFields, "quoteAmount" | "contractTotal">> & {
  name: string;
  quoteAmount?: Money | number | null;
  contractTotal?: Money | number | null;
};

/** PATCH body: only the fields that change. */
export type VendorUpdateInput = Partial<VendorCreateInput>;
