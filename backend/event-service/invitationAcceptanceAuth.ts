export const invitationAcceptancePath = "/event-invitations/accept";
export const invitationAuthorizerVersion = "1";

export interface VerifiedInvitationIdentity {
  sub: string;
  email: string;
}

export function invitationAcceptanceRoute(arn: string | undefined) {
  const match = /^arn:aws:execute-api:[a-z0-9-]+:([0-9]{12}):([a-z0-9]+)\/([A-Za-z0-9_-]+)\/POST\/event-invitations\/accept$/.exec(arn ?? "");
  if (!match || match[0] !== arn) return undefined;
  return { arn, accountId: match[1], apiId: match[2], stage: match[3] };
}

export function validInvitationSubject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

export function invitationBearer(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer +([^\s,]+)$/i.exec(value);
  return match?.[0] === value ? match[1] : undefined;
}
