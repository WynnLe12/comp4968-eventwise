import test from "node:test";
import assert from "node:assert/strict";
import { PublishCommand } from "@aws-sdk/client-sns";
import {
  addDays,
  AlertService,
  budgetDedupeKey,
  daysBetween,
  formatAlertEmail,
  paymentDedupeKey,
} from "../notification-service/services/alertService";
import {
  createSnsAlertPublisher,
  truncateSnsSubject,
} from "../notification-service/services/snsPublisher";
import { createAlertsHandler } from "../notification-service/handlers/alerts";
import {
  createAlertEmailSenderHandler,
  createCognitoEmailResolver,
  createSesAlertSender,
} from "../notification-service/handlers/emailSender";
import { ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { alertIdentityKey } from "../notification-service/repositories/mysql-alerts";
import type {
  AlertCandidateKey,
  AlertNotificationMessage,
  AlertRepository,
  BudgetOverrunRow,
  DuePaymentRow,
  SentAlertRecord,
} from "../notification-service/types";

class InMemoryAlertRepository implements AlertRepository {
  public duePayments: DuePaymentRow[] = [];
  public budgetOverruns: BudgetOverrunRow[] = [];
  public sentRecords: SentAlertRecord[] = [];
  public lastRange: { startDate: string; endDate: string } | null = null;

  async findDuePayments(startDate: string, endDate: string): Promise<DuePaymentRow[]> {
    this.lastRange = { startDate, endDate };
    return this.duePayments;
  }

  async findBudgetOverruns(): Promise<BudgetOverrunRow[]> {
    return this.budgetOverruns;
  }

  async findSentKeys(candidates: AlertCandidateKey[]): Promise<Set<string>> {
    const existing = new Set(this.sentRecords.map(alertIdentityKey));
    const matches = new Set<string>();
    for (const c of candidates) {
      const key = alertIdentityKey(c);
      if (existing.has(key)) matches.add(key);
    }
    return matches;
  }

  async recordSentAlerts(records: SentAlertRecord[]): Promise<void> {
    const existing = new Set(this.sentRecords.map(alertIdentityKey));
    for (const record of records) {
      const key = alertIdentityKey(record);
      if (!existing.has(key)) {
        this.sentRecords.push(record);
        existing.add(key);
      }
    }
  }
}

function makePayment(overrides: Partial<DuePaymentRow> = {}): DuePaymentRow {
  return {
    eventId: "1",
    eventName: "Maya & Eli's Wedding",
    ownerSub: "owner-maya",
    ownerDisplayName: "Maya",
    expenseId: "10",
    description: "Final Photography Balance",
    categoryName: "Photo & Video",
    vendorName: "Lumen Photography",
    dueDate: "2026-12-01",
    committedAmount: "2500.00",
    paidTotal: "400.00",
    ...overrides,
  };
}

function makeOverrun(overrides: Partial<BudgetOverrunRow> = {}): BudgetOverrunRow {
  return {
    eventId: "1",
    eventName: "Maya & Eli's Wedding",
    ownerSub: "owner-maya",
    ownerDisplayName: "Maya",
    categoryId: "4",
    categoryName: "Flowers & Decor",
    plannedAmount: "1000.00",
    committedTotal: "1350.00",
    ...overrides,
  };
}

test("date helpers compute exact UTC boundaries across month and leap-year rollovers", () => {
  assert.equal(addDays("2026-11-26", 7), "2026-12-03");
  assert.equal(addDays("2028-02-25", 7), "2028-03-03");
  assert.equal(daysBetween("2026-11-26", "2026-11-26"), 0);
  assert.equal(daysBetween("2026-11-26", "2026-12-03"), 7);
  assert.equal(daysBetween("2026-11-26", "2026-12-04"), 8);
  assert.equal(daysBetween("2026-11-26", "2026-11-25"), -1);
});

test("due-date boundary: includes day 0 and day 7, excludes day -1 and day 8", async () => {
  const repo = new InMemoryAlertRepository();
  repo.duePayments = [
    makePayment({ expenseId: "1", description: "Past due", dueDate: "2026-11-25" }),
    makePayment({ expenseId: "2", description: "Due today", dueDate: "2026-11-26" }),
    makePayment({ expenseId: "3", description: "Due in 7 days", dueDate: "2026-12-03" }),
    makePayment({ expenseId: "4", description: "Due in 8 days", dueDate: "2026-12-04" }),
  ];

  const published: AlertNotificationMessage[] = [];
  const service = new AlertService({
    repository: repo,
    publisher: {
      async publish(message) {
        published.push(message);
        return "msg-1";
      },
    },
    today: () => "2026-11-26",
  });

  const summary = await service.run();
  assert.deepEqual(repo.lastRange, { startDate: "2026-11-26", endDate: "2026-12-03" });
  assert.equal(summary.paymentsDueFound, 2);
  assert.equal(summary.notificationsSent, 1);
  assert.equal(summary.alertsRecorded, 2);
  assert.equal(published.length, 1);
  assert.match(published[0]!.body, /Due today.*due today/);
  assert.match(published[0]!.body, /Due in 7 days.*due in 7 days/);
  assert.doesNotMatch(published[0]!.body, /Past due/);
  assert.doesNotMatch(published[0]!.body, /Due in 8 days/);
});

test("false alerts: ignores fully paid expenses and on-budget or under-budget categories", async () => {
  const repo = new InMemoryAlertRepository();
  repo.duePayments = [
    makePayment({ expenseId: "1", committedAmount: "500.00", paidTotal: "500.00", dueDate: "2026-11-28" }),
    makePayment({ expenseId: "2", committedAmount: "0.00", paidTotal: "0.00", dueDate: "2026-11-28" }),
  ];
  repo.budgetOverruns = [
    makeOverrun({ categoryId: "1", plannedAmount: "1000.00", committedTotal: "1000.00" }),
    makeOverrun({ categoryId: "2", plannedAmount: "1000.00", committedTotal: "999.99" }),
  ];

  const published: AlertNotificationMessage[] = [];
  const service = new AlertService({
    repository: repo,
    publisher: {
      async publish(message) {
        published.push(message);
        return "msg-none";
      },
    },
    today: () => "2026-11-26",
  });

  const summary = await service.run();
  assert.equal(summary.paymentsDueFound, 0);
  assert.equal(summary.budgetOverrunsFound, 0);
  assert.equal(summary.notificationsSent, 0);
  assert.equal(published.length, 0);
  assert.equal(repo.sentRecords.length, 0);
});

test("detects 1-cent budget overrun and exact remaining payment balance", async () => {
  const repo = new InMemoryAlertRepository();
  repo.duePayments = [
    makePayment({ expenseId: "11", committedAmount: "1234.56", paidTotal: "234.55", dueDate: "2026-11-27" }),
  ];
  repo.budgetOverruns = [
    makeOverrun({ categoryId: "5", plannedAmount: "500.00", committedTotal: "500.01" }),
  ];

  const published: AlertNotificationMessage[] = [];
  const service = new AlertService({
    repository: repo,
    publisher: {
      async publish(message) {
        published.push(message);
        return "msg-exact";
      },
    },
    today: () => "2026-11-26",
  });

  const summary = await service.run();
  assert.equal(summary.notificationsSent, 1);
  assert.deepEqual(published[0]!.alertTypes, ["PAYMENT_DUE", "BUDGET_OVERRUN"]);
  assert.match(published[0]!.body, /\$1000\.01 remaining of \$1234\.56/);
  assert.match(published[0]!.body, /due tomorrow/);
  assert.match(published[0]!.body, /\$500\.01 spent vs \$500\.00 planned \(\$0\.01 over budget\)/);
});

test("repeated schedules deduplicate alerts and re-notify only when due date or overrun changes", async () => {
  const repo = new InMemoryAlertRepository();
  repo.duePayments = [makePayment({ expenseId: "10", dueDate: "2026-12-01" })];
  repo.budgetOverruns = [makeOverrun({ categoryId: "4", plannedAmount: "1000.00", committedTotal: "1350.00" })];

  const published: AlertNotificationMessage[] = [];
  const service = new AlertService({
    repository: repo,
    publisher: {
      async publish(message) {
        published.push(message);
        return `msg-${published.length}`;
      },
    },
  });

  // Day 1: first run sends 1 combined alert and records 2 items.
  const run1 = await service.run({ runDate: "2026-11-26" });
  assert.equal(run1.notificationsSent, 1);
  assert.equal(run1.alertsRecorded, 2);
  assert.equal(run1.alertsSkippedAsDuplicate, 0);

  // Day 1 retry & Day 2 morning run: zero duplicate notifications!
  const run2 = await service.run({ runDate: "2026-11-26" });
  assert.equal(run2.notificationsSent, 0);
  assert.equal(run2.alertsSkippedAsDuplicate, 2);

  const run3 = await service.run({ runDate: "2026-11-27" });
  assert.equal(run3.notificationsSent, 0);
  assert.equal(run3.alertsSkippedAsDuplicate, 2);

  // Spending increases in Flowers & Decor -> new dedupe key triggers fresh alert, payment stays skipped.
  repo.budgetOverruns = [makeOverrun({ categoryId: "4", plannedAmount: "1000.00", committedTotal: "1500.00" })];
  const run4 = await service.run({ runDate: "2026-11-28" });
  assert.equal(run4.notificationsSent, 1);
  assert.equal(run4.alertsSkippedAsDuplicate, 1);
  assert.equal(run4.alertsRecorded, 1);
  assert.deepEqual(published[1]!.alertTypes, ["BUDGET_OVERRUN"]);

  // Expense due date rescheduled -> new dedupe key triggers fresh alert.
  repo.duePayments = [makePayment({ expenseId: "10", dueDate: "2026-12-04" })];
  const run5 = await service.run({ runDate: "2026-11-29" });
  assert.equal(run5.notificationsSent, 1);
  assert.equal(run5.alertsSkippedAsDuplicate, 1);
  assert.deepEqual(published[2]!.alertTypes, ["PAYMENT_DUE"]);
  assert.equal(paymentDedupeKey("2026-12-04"), "due:2026-12-04");
  assert.equal(budgetDedupeKey("1000.00", "1500.00"), "overrun:1000.00:1500.00");
});

test("SNS failure on one event does not record sent alerts or block other events", async () => {
  const repo = new InMemoryAlertRepository();
  repo.duePayments = [
    makePayment({ eventId: "1", eventName: "Event One", ownerSub: "owner-1", expenseId: "10", dueDate: "2026-11-28" }),
    makePayment({ eventId: "2", eventName: "Event Two", ownerSub: "owner-2", expenseId: "20", dueDate: "2026-11-28" }),
  ];

  const service = new AlertService({
    repository: repo,
    publisher: {
      async publish(message) {
        if (message.eventId === "1") throw new Error("SNS throttled");
        return "msg-ok";
      },
    },
    today: () => "2026-11-26",
  });

  const summary = await service.run();
  assert.equal(summary.eventsEvaluated, 2);
  assert.equal(summary.notificationsSent, 1);
  assert.equal(summary.failedEvents, 1);
  assert.equal(summary.alertsRecorded, 1);
  assert.equal(repo.sentRecords.length, 1);
  assert.equal(repo.sentRecords[0]!.eventId, "2");
});

test("SNS publisher sends TopicArn, truncated Subject <= 100 chars, and ownerSub MessageAttributes", async () => {
  const commands: PublishCommand[] = [];
  const publisher = createSnsAlertPublisher("arn:aws:sns:us-west-2:123456789012:eventwise-alerts", {
    async send(command: unknown) {
      commands.push(command as PublishCommand);
      return { MessageId: "sns-123" } as never;
    },
  });

  const longSubject = "EventWise Alert (" + "A".repeat(120) + "): 1 payment due soon";
  assert.ok(truncateSnsSubject(longSubject).length <= 100);

  const id = await publisher.publish({
    eventId: "42",
    eventName: "Big Gala",
    ownerSub: "sub-owner-42",
    ownerDisplayName: "Nico",
    subject: longSubject,
    body: "Alert body",
    alertTypes: ["PAYMENT_DUE", "BUDGET_OVERRUN"],
  });

  assert.equal(id, "sns-123");
  assert.equal(commands.length, 1);
  const input = commands[0]!.input;
  assert.equal(input.TopicArn, "arn:aws:sns:us-west-2:123456789012:eventwise-alerts");
  assert.ok((input.Subject?.length ?? 0) <= 100);
  assert.equal(input.MessageAttributes?.ownerSub?.StringValue, "sub-owner-42");
  assert.equal(input.MessageAttributes?.eventId?.StringValue, "42");
  assert.equal(input.MessageAttributes?.alertTypes?.StringValue, "PAYMENT_DUE,BUDGET_OVERRUN");
});

test("Lambda handler delegates to AlertService and forwards optional runDate/windowDays", async () => {
  let received: { runDate?: string; windowDays?: number } | undefined;
  const handler = createAlertsHandler({
    service: {
      async run(options = {}) {
        received = options;
        return {
          runDate: options.runDate ?? "2026-11-26",
          windowDays: options.windowDays ?? 7,
          eventsEvaluated: 0,
          paymentsDueFound: 0,
          budgetOverrunsFound: 0,
          alertsSkippedAsDuplicate: 0,
          notificationsSent: 0,
          alertsRecorded: 0,
          failedEvents: 0,
        };
      },
    },
  });

  const result = await handler({ runDate: "2026-12-01", windowDays: 7 });
  assert.deepEqual(received, { runDate: "2026-12-01", windowDays: 7 });
  assert.equal(result.runDate, "2026-12-01");

  const formatted = formatAlertEmail("Gala", null, "2026-12-01", [], []);
  assert.match(formatted.body, /^Hi,/);
});

test("Cognito email resolver looks up owner email by sub, caches it, and rejects unsafe sub", async () => {
  const commands: ListUsersCommand[] = [];
  const resolve = createCognitoEmailResolver("us-west-2_bV89z9COo", {
    async send(command: unknown) {
      commands.push(command as ListUsersCommand);
      return {
        Users: [
          {
            Attributes: [
              { Name: "sub", Value: "owner-sub-1" },
              { Name: "email", Value: "Owner1@Example.com" },
            ],
          },
        ],
      } as never;
    },
  });

  assert.equal(await resolve("owner-sub-1"), "owner1@example.com");
  assert.equal(await resolve("owner-sub-1"), "owner1@example.com");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.input.Filter, 'sub = "owner-sub-1"');

  // Unsafe characters in sub are rejected before calling Cognito
  assert.equal(await resolve('bad"sub'), null);
  assert.equal(commands.length, 1);
});

test("Alert email sender Lambda delivers each SNS alert to its specific event owner via SES", async () => {
  const sentEmails: Array<{ from: string; to: string; subject: string; text: string }> = [];
  const emailsBySub: Record<string, string | null> = {
    "sub-alice": "alice@example.com",
    "sub-bob": "bob@example.com",
    "sub-missing": null,
  };

  const handler = createAlertEmailSenderHandler({
    resolveOwnerEmail: async (sub) => emailsBySub[sub] ?? null,
    sendEmail: async (input) => {
      sentEmails.push(input);
    },
    env: { SES_FROM_ADDRESS: "alerts@eventwise.app" },
  });

  const summary = await handler({
    Records: [
      {
        Sns: {
          MessageId: "m1",
          Subject: "EventWise Alert (Alice Wedding): 1 payment due soon",
          Message: "Hi Alice, payment due.",
          MessageAttributes: { ownerSub: { Type: "String", Value: "sub-alice" } },
        },
      },
      {
        Sns: {
          MessageId: "m2",
          Subject: "EventWise Alert (Bob Gala): 1 category over budget",
          Message: "Hi Bob, over budget.",
          MessageAttributes: { ownerSub: { Type: "String", Value: "sub-bob" } },
        },
      },
      {
        Sns: {
          MessageId: "m3",
          Subject: "Orphan Event",
          Message: "No email in Cognito.",
          MessageAttributes: { ownerSub: { Type: "String", Value: "sub-missing" } },
        },
      },
    ],
  });

  assert.deepEqual(summary, { processed: 3, sent: 2, skipped: 1, failed: 0 });
  assert.equal(sentEmails.length, 2);
  assert.equal(sentEmails[0]!.to, "alice@example.com");
  assert.equal(sentEmails[1]!.to, "bob@example.com");

  // Verify SESv2 SendEmailCommand construction
  const sesCommands: SendEmailCommand[] = [];
  const sesSender = createSesAlertSender({
    async send(command: unknown) {
      sesCommands.push(command as SendEmailCommand);
      return {} as never;
    },
  });
  await sesSender({
    from: "alerts@eventwise.app",
    to: "alice@example.com",
    subject: "Test Subject",
    text: "Test Body",
  });
  assert.equal(sesCommands.length, 1);
  assert.deepEqual(sesCommands[0]!.input.Destination?.ToAddresses, ["alice@example.com"]);
  assert.equal(sesCommands[0]!.input.FromEmailAddress, "alerts@eventwise.app");
});
