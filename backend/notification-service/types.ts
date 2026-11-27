export type AlertType = "PAYMENT_DUE" | "BUDGET_OVERRUN";

export interface DuePaymentRow {
  eventId: string;
  eventName: string;
  ownerSub: string;
  ownerDisplayName: string | null;
  expenseId: string;
  description: string;
  categoryName: string;
  vendorName: string | null;
  dueDate: string;
  committedAmount: string;
  paidTotal: string;
}

export interface PaymentDueAlert extends DuePaymentRow {
  outstandingAmount: string;
  daysUntilDue: number;
  dedupeKey: string;
}

export interface BudgetOverrunRow {
  eventId: string;
  eventName: string;
  ownerSub: string;
  ownerDisplayName: string | null;
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  committedTotal: string;
}

export interface BudgetOverrunAlert extends BudgetOverrunRow {
  overrunAmount: string;
  dedupeKey: string;
}

export interface AlertCandidateKey {
  eventId: string;
  alertType: AlertType;
  entityId: string;
  dedupeKey: string;
}

export interface SentAlertRecord extends AlertCandidateKey {
  ownerSub: string;
  alertDate: string;
  detailsSnapshot: string;
  snsMessageId: string | null;
}

export interface AlertNotificationMessage {
  eventId: string;
  eventName: string;
  ownerSub: string;
  ownerDisplayName: string | null;
  subject: string;
  body: string;
  alertTypes: AlertType[];
}

export interface AlertPublisher {
  publish(message: AlertNotificationMessage): Promise<string | undefined>;
}

export interface AlertRepository {
  findDuePayments(startDate: string, endDate: string): Promise<DuePaymentRow[]>;
  findBudgetOverruns(): Promise<BudgetOverrunRow[]>;
  findSentKeys(candidates: AlertCandidateKey[]): Promise<Set<string>>;
  recordSentAlerts(records: SentAlertRecord[]): Promise<void>;
}

export interface AlertRunSummary {
  runDate: string;
  windowDays: number;
  eventsEvaluated: number;
  paymentsDueFound: number;
  budgetOverrunsFound: number;
  alertsSkippedAsDuplicate: number;
  notificationsSent: number;
  alertsRecorded: number;
  failedEvents: number;
}
