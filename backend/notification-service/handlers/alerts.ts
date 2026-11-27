// Feature 9: Daily Payment & Budget Alerts Lambda
// Handler: notification-service/handlers/alerts.handler
// Invoked daily by Amazon EventBridge Scheduler. Queries RDS MySQL for unpaid
// expenses due within 7 days and categories over budget, deduplicates against
// alert_notifications, and publishes owner alerts to Amazon SNS.

import { MySqlAlertRepository } from "../repositories/mysql-alerts";
import { AlertService } from "../services/alertService";
import { createSnsAlertPublisher } from "../services/snsPublisher";
import type { AlertRunSummary } from "../types";

export interface ScheduledAlertEvent {
  runDate?: string;
  windowDays?: number;
}

export function createAlertsHandler(
  dependencies: {
    service?: Pick<AlertService, "run">;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const env = dependencies.env ?? process.env;
  const service =
    dependencies.service ??
    new AlertService({
      repository: new MySqlAlertRepository(),
      publisher: createSnsAlertPublisher(env.ALERTS_SNS_TOPIC_ARN),
    });

  return async (event: ScheduledAlertEvent = {}): Promise<AlertRunSummary> => {
    if (!dependencies.service) {
      if (!env.ALERTS_SNS_TOPIC_ARN?.trim()) {
        throw new Error("ALERTS_SNS_TOPIC_ARN environment variable is required.");
      }
      if (!env.DB_HOST?.trim() || !env.DB_NAME?.trim()) {
        throw new Error("DB_HOST and DB_NAME environment variables are required.");
      }
    }

    const summary = await service.run({
      runDate: typeof event?.runDate === "string" ? event.runDate : undefined,
      windowDays: typeof event?.windowDays === "number" ? event.windowDays : undefined,
    });

    console.log("Daily alert run completed:", JSON.stringify(summary));
    return summary;
  };
}

export const handler = createAlertsHandler();
