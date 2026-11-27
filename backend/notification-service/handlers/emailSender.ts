// Feature 9: Payment & Budget Alerts Email Sender Lambda (non-VPC)
// Handler: notification-service/handlers/emailSender.handler
// Subscribed to the eventwise-payment-budget-alerts SNS topic.
// Runs OUTSIDE the VPC so it can reach Amazon Cognito (to resolve ownerSub -> email)
// and Amazon SES (to deliver the alert directly to that event's owner).

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface SnsMessageAttribute {
  Type?: string;
  Value?: string;
}

export interface SnsRecord {
  Sns?: {
    MessageId?: string;
    Subject?: string | null;
    Message?: string;
    MessageAttributes?: Record<string, SnsMessageAttribute | undefined>;
  };
}

export interface SnsEvent {
  Records?: SnsRecord[];
}

export interface EmailSenderSummary {
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
}

export type ResolveOwnerEmail = (ownerSub: string) => Promise<string | null>;
export type SendAlertEmail = (input: {
  from: string;
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

const SAFE_SUB_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function createCognitoEmailResolver(
  userPoolId: string | undefined = process.env.COGNITO_USER_POOL_ID,
  client: Pick<CognitoIdentityProviderClient, "send"> = new CognitoIdentityProviderClient({
    maxAttempts: 3,
  }),
): ResolveOwnerEmail {
  const cache = new Map<string, string | null>();

  return async (ownerSub: string): Promise<string | null> => {
    const trimmedSub = ownerSub.trim();
    if (!SAFE_SUB_PATTERN.test(trimmedSub)) {
      return null;
    }
    if (cache.has(trimmedSub)) {
      return cache.get(trimmedSub) ?? null;
    }

    const poolId = userPoolId?.trim();
    if (!poolId) {
      throw new Error("COGNITO_USER_POOL_ID environment variable is required.");
    }

    const response = await client.send(
      new ListUsersCommand({
        UserPoolId: poolId,
        Filter: `sub = "${trimmedSub}"`,
        Limit: 1,
      }),
    );

    const user = response.Users?.[0];
    const attributes = user?.Attributes ?? [];
    const email = attributes.find(a => a.Name === "email")?.Value?.trim().toLowerCase() ?? null;
    const result = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    cache.set(trimmedSub, result);
    return result;
  };
}

export function createSesAlertSender(
  client: Pick<SESv2Client, "send"> = new SESv2Client({ maxAttempts: 3 }),
): SendAlertEmail {
  return async ({ from, to, subject, text }): Promise<void> => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" } },
          },
        },
      }),
      { abortSignal: AbortSignal.timeout(8_000) },
    );
  };
}

export function createAlertEmailSenderHandler(
  dependencies: {
    resolveOwnerEmail?: ResolveOwnerEmail;
    sendEmail?: SendAlertEmail;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const env = dependencies.env ?? process.env;
  const resolveOwnerEmail =
    dependencies.resolveOwnerEmail ?? createCognitoEmailResolver(env.COGNITO_USER_POOL_ID);
  const sendEmail = dependencies.sendEmail ?? createSesAlertSender();

  return async (event: SnsEvent = {}): Promise<EmailSenderSummary> => {
    const from = env.SES_FROM_ADDRESS?.trim();
    if (!from) {
      throw new Error("SES_FROM_ADDRESS environment variable is required.");
    }

    const records = event.Records ?? [];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const record of records) {
      const sns = record.Sns;
      const messageId = sns?.MessageId ?? "unknown";
      const ownerSub = sns?.MessageAttributes?.ownerSub?.Value?.trim();
      const body = sns?.Message?.trim();
      const subject = sns?.Subject?.trim() || "EventWise Alert";

      if (!ownerSub || !body) {
        console.warn(`Alert SNS message ${messageId} skipped: missing ownerSub or message body`);
        skipped += 1;
        continue;
      }

      try {
        const ownerEmail = await resolveOwnerEmail(ownerSub);
        if (!ownerEmail) {
          console.warn(`Alert SNS message ${messageId} skipped: no email found in Cognito for owner`);
          skipped += 1;
          continue;
        }

        await sendEmail({ from, to: ownerEmail, subject, text: body });
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `Alert SNS message ${messageId} failed:`,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        );
      }
    }

    const summary: EmailSenderSummary = {
      processed: records.length,
      sent,
      skipped,
      failed,
    };
    console.log("Alert email sender completed:", JSON.stringify(summary));
    return summary;
  };
}

export const handler = createAlertEmailSenderHandler();
