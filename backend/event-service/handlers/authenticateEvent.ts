import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken } from "../../shared/auth/verifyToken";
import { sendJson } from "../../shared/utils/http";

export interface EventAuthentication {
  verifyToken?: (token: string) => Promise<string>;
  /** Trusted transport adapter only; never populate this from a client field. */
  resolveIdentity?: () => Promise<string>;
}

/** Keep the local bearer-token contract while allowing verified Gateway identity. */
export async function authenticateEvent(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: EventAuthentication,
): Promise<string | undefined> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (!dependencies.resolveIdentity && !token) {
    sendJson(response, 401, { error: "Missing or invalid authentication token" });
    return;
  }
  try {
    const sub = dependencies.resolveIdentity
      ? await dependencies.resolveIdentity()
      : await (dependencies.verifyToken ?? verifyToken)(token!);
    if (typeof sub !== "string" || !sub || sub.length > 128) throw new Error("Invalid subject");
    return sub;
  } catch {
    sendJson(response, 401, { error: "Invalid or expired authentication token" });
    return;
  }
}
