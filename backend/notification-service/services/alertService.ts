import { cents, money } from "../../expense-service/services/validation";
import { validDate } from "../../shared/utils/dateOnly";
import { alertIdentityKey } from "../repositories/mysql-alerts";
import type {
  AlertCandidateKey,
  AlertNotificationMessage,
  AlertPublisher,
  AlertRepository,
  AlertRunSummary,
  AlertType,
  BudgetOverrunAlert,
  PaymentDueAlert,
  SentAlertRecord,
} from "../types";

export const DEFAULT_DUE_WINDOW_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export function addDays(isoDate: string, days: number): string {
  if (!validDate(isoDate)) throw new Error(`Invalid ISO date: ${isoDate}`);
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  if (!validDate(fromIso) || !validDate(toIso)) {
    throw new Error(`Invalid ISO date range: ${fromIso} -> ${toIso}`);
  }
  const fromMs = Date.parse(`${fromIso}T00:00:00.000Z`);
  const toMs = Date.parse(`${toIso}T00:00:00.000Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

export function paymentDedupeKey(dueDate: string): string {
  return `due:${dueDate}`;
}

export function budgetDedupeKey(plannedAmount: string, committedTotal: string): string {
  return `overrun:${plannedAmount}:${committedTotal}`;
}

export function formatAlertEmail(
  eventName: string,
  ownerDisplayName: string | null,
  runDate: string,
  duePayments: PaymentDueAlert[],
  budgetOverruns: BudgetOverrunAlert[],
): { subject: string; body: string } {
  const parts: string[] = [];
  if (duePayments.length > 0) {
    parts.push(`${duePayments.length} payment${duePayments.length === 1 ? "" : "s"} due soon`);
  }
  if (budgetOverruns.length > 0) {
    parts.push(`${budgetOverruns.length} categor${budgetOverruns.length === 1 ? "y" : "ies"} over budget`);
  }

  const subject = `EventWise Alert (${eventName}): ${parts.join(" & ")}`;
  const greeting = ownerDisplayName ? `Hi ${ownerDisplayName},` : "Hi,";
  const lines: string[] = [
    greeting,
    "",
    `Here is your daily EventWise alert summary for "${eventName}" (${runDate}):`,
  ];

  if (duePayments.length > 0) {
    lines.push("", "UPCOMING PAYMENTS DUE (WITHIN 7 DAYS):");
    for (const p of duePayments) {
      const timing =
        p.daysUntilDue === 0
          ? "due today"
          : p.daysUntilDue === 1
            ? "due tomorrow"
            : `due in ${p.daysUntilDue} days`;
      const vendorPart = p.vendorName ? ` (${p.vendorName})` : "";
      lines.push(
        `- ${p.description}${vendorPart} [${p.categoryName}]: $${p.outstandingAmount} remaining of $${p.committedAmount} — due ${p.dueDate} (${timing})`,
      );
    }
  }

  if (budgetOverruns.length > 0) {
    lines.push("", "CATEGORIES OVER BUDGET:");
    for (const b of budgetOverruns) {
      lines.push(
        `- ${b.categoryName}: $${b.committedTotal} spent vs $${b.plannedAmount} planned ($${b.overrunAmount} over budget)`,
      );
    }
  }

  lines.push("", "Log in to EventWise to review your budget and upcoming payments.");
  return { subject, body: lines.join("\n") };
}

interface EventAlertBundle {
  eventId: string;
  eventName: string;
  ownerSub: string;
  ownerDisplayName: string | null;
  duePayments: PaymentDueAlert[];
  budgetOverruns: BudgetOverrunAlert[];
}

export interface AlertServiceDependencies {
  repository: AlertRepository;
  publisher: AlertPublisher;
  today?: () => string;
  windowDays?: number;
}

export class AlertService {
  private readonly repository: AlertRepository;
  private readonly publisher: AlertPublisher;
  private readonly today: () => string;
  private readonly defaultWindowDays: number;

  constructor(dependencies: AlertServiceDependencies) {
    this.repository = dependencies.repository;
    this.publisher = dependencies.publisher;
    this.today = dependencies.today ?? (() => new Date().toISOString().slice(0, 10));
    this.defaultWindowDays = dependencies.windowDays ?? DEFAULT_DUE_WINDOW_DAYS;
  }

  async run(options: { runDate?: string; windowDays?: number } = {}): Promise<AlertRunSummary> {
    const runDate = options.runDate ?? this.today();
    const windowDays = options.windowDays ?? this.defaultWindowDays;
    if (!validDate(runDate)) {
      throw new Error(`Invalid runDate: ${runDate}`);
    }
    if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 365) {
      throw new Error(`Invalid windowDays: ${windowDays}`);
    }

    const endDate = addDays(runDate, windowDays);
    const [rawPayments, rawOverruns] = await Promise.all([
      this.repository.findDuePayments(runDate, endDate),
      this.repository.findBudgetOverruns(),
    ]);

    // Defense-in-depth validation of financial and date boundaries.
    const validPayments: PaymentDueAlert[] = [];
    for (const row of rawPayments) {
      if (!row.dueDate || !validDate(row.dueDate)) continue;
      const daysUntilDue = daysBetween(runDate, row.dueDate);
      if (daysUntilDue < 0 || daysUntilDue > windowDays) continue;

      const committed = cents(row.committedAmount);
      const paid = cents(row.paidTotal);
      const outstanding = committed - paid;
      if (outstanding <= 0n) continue;

      validPayments.push({
        ...row,
        committedAmount: money(committed),
        paidTotal: money(paid),
        outstandingAmount: money(outstanding),
        daysUntilDue,
        dedupeKey: paymentDedupeKey(row.dueDate),
      });
    }

    const validOverruns: BudgetOverrunAlert[] = [];
    for (const row of rawOverruns) {
      const planned = cents(row.plannedAmount);
      const committed = cents(row.committedTotal);
      if (committed <= planned) continue;

      const plannedText = money(planned);
      const committedText = money(committed);
      validOverruns.push({
        ...row,
        plannedAmount: plannedText,
        committedTotal: committedText,
        overrunAmount: money(committed - planned),
        dedupeKey: budgetDedupeKey(plannedText, committedText),
      });
    }

    const candidates: AlertCandidateKey[] = [
      ...validPayments.map(p => ({
        eventId: p.eventId,
        alertType: "PAYMENT_DUE" as const,
        entityId: p.expenseId,
        dedupeKey: p.dedupeKey,
      })),
      ...validOverruns.map(b => ({
        eventId: b.eventId,
        alertType: "BUDGET_OVERRUN" as const,
        entityId: b.categoryId,
        dedupeKey: b.dedupeKey,
      })),
    ];

    const alreadySent = await this.repository.findSentKeys(candidates);

    const bundles = new Map<string, EventAlertBundle>();
    let alertsSkippedAsDuplicate = 0;

    const getBundle = (
      eventId: string,
      eventName: string,
      ownerSub: string,
      ownerDisplayName: string | null,
    ): EventAlertBundle => {
      let bundle = bundles.get(eventId);
      if (!bundle) {
        bundle = { eventId, eventName, ownerSub, ownerDisplayName, duePayments: [], budgetOverruns: [] };
        bundles.set(eventId, bundle);
      }
      return bundle;
    };

    for (const payment of validPayments) {
      const key = alertIdentityKey({
        eventId: payment.eventId,
        alertType: "PAYMENT_DUE",
        entityId: payment.expenseId,
        dedupeKey: payment.dedupeKey,
      });
      if (alreadySent.has(key)) {
        alertsSkippedAsDuplicate += 1;
        continue;
      }
      getBundle(payment.eventId, payment.eventName, payment.ownerSub, payment.ownerDisplayName)
        .duePayments.push(payment);
    }

    for (const overrun of validOverruns) {
      const key = alertIdentityKey({
        eventId: overrun.eventId,
        alertType: "BUDGET_OVERRUN",
        entityId: overrun.categoryId,
        dedupeKey: overrun.dedupeKey,
      });
      if (alreadySent.has(key)) {
        alertsSkippedAsDuplicate += 1;
        continue;
      }
      getBundle(overrun.eventId, overrun.eventName, overrun.ownerSub, overrun.ownerDisplayName)
        .budgetOverruns.push(overrun);
    }

    let notificationsSent = 0;
    let alertsRecorded = 0;
    let failedEvents = 0;

    for (const bundle of bundles.values()) {
      const { subject, body } = formatAlertEmail(
        bundle.eventName,
        bundle.ownerDisplayName,
        runDate,
        bundle.duePayments,
        bundle.budgetOverruns,
      );
      const alertTypes: AlertType[] = [];
      if (bundle.duePayments.length > 0) alertTypes.push("PAYMENT_DUE");
      if (bundle.budgetOverruns.length > 0) alertTypes.push("BUDGET_OVERRUN");

      const message: AlertNotificationMessage = {
        eventId: bundle.eventId,
        eventName: bundle.eventName,
        ownerSub: bundle.ownerSub,
        ownerDisplayName: bundle.ownerDisplayName,
        subject,
        body,
        alertTypes,
      };

      try {
        const messageId = await this.publisher.publish(message);
        notificationsSent += 1;

        const records: SentAlertRecord[] = [
          ...bundle.duePayments.map(p => ({
            eventId: bundle.eventId,
            ownerSub: bundle.ownerSub,
            alertType: "PAYMENT_DUE" as const,
            entityId: p.expenseId,
            dedupeKey: p.dedupeKey,
            alertDate: runDate,
            detailsSnapshot: `${p.description}: $${p.outstandingAmount} due ${p.dueDate}`,
            snsMessageId: messageId ?? null,
          })),
          ...bundle.budgetOverruns.map(b => ({
            eventId: bundle.eventId,
            ownerSub: bundle.ownerSub,
            alertType: "BUDGET_OVERRUN" as const,
            entityId: b.categoryId,
            dedupeKey: b.dedupeKey,
            alertDate: runDate,
            detailsSnapshot: `${b.categoryName}: $${b.committedTotal} / $${b.plannedAmount} (+$${b.overrunAmount})`,
            snsMessageId: messageId ?? null,
          })),
        ];

        await this.repository.recordSentAlerts(records);
        alertsRecorded += records.length;
      } catch (error) {
        failedEvents += 1;
        console.error(
          `Failed to send or record alerts for event ${bundle.eventId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return {
      runDate,
      windowDays,
      eventsEvaluated: bundles.size,
      paymentsDueFound: validPayments.length,
      budgetOverrunsFound: validOverruns.length,
      alertsSkippedAsDuplicate,
      notificationsSent,
      alertsRecorded,
      failedEvents,
    };
  }
}
