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
