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
  vendor: string;
  category: string;
  total: number;
  paid: number;
  due: string;
  status: string;
}

export interface Guest {
  name: string;
  group: string;
  party: number;
  rsvp: string;
  meal: string;
}

export type BookingStatus = "researching" | "quoted" | "booked" | "declined";
export type ContractStatus = "none" | "sent" | "signed" | "cancelled";

/** Fields the organizer can edit. These are the only fields create/update accept. */
export interface VendorStoredFields {
  eventId: string;
  name: string;
  category: string;
  contactName: string;
  email: string;
  phone: string;
  quoteAmount: number | null;
  contractTotal: number | null;
  bookingStatus: BookingStatus;
  contractStatus: ContractStatus;
}

/**
 * A vendor as returned by the service. paidTotal, balance and nextDueDate are
 * computed by the server from the vendor's expenses; the UI only displays them.
 */
export interface Vendor extends VendorStoredFields {
  id: string;
  paidTotal: number;
  /** null when the vendor has no contract total. */
  balance: number | null;
  /** ISO date (YYYY-MM-DD) of the next unpaid expense, or null. */
  nextDueDate: string | null;
}

export type VendorCreateInput = VendorStoredFields;
export type VendorUpdateInput = Partial<Omit<VendorStoredFields, "eventId">>;
