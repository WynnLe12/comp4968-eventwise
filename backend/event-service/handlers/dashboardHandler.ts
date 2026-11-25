import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "../../expense-service/errors";
import { sendJson } from "../../shared/utils/http";
import { DashboardService } from "../services/dashboardService";
import { EventAccessDeniedError, EventNotFoundError, EventValidationError } from "../services/eventService";
import { authenticateEvent, type EventAuthentication } from "./authenticateEvent";

export interface DashboardHandlerDependencies extends EventAuthentication {
  service: Pick<DashboardService, "get">;
}

/** GET /events/{eventId}/dashboard (Feature 10). See docs/api/dashboard.md. */
export function dashboardHandler(dependencies: Partial<DashboardHandlerDependencies> = {}) {
  const service = dependencies.service ?? new DashboardService();
  return async (request: IncomingMessage, response: ServerResponse, eventId: string): Promise<void> => {
    const cognitoSub = await authenticateEvent(request, response, dependencies);
    if (cognitoSub === undefined) return;
    try {
      sendJson(response, 200, await service.get(eventId, cognitoSub), { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof EventValidationError) {
        sendJson(response, 400, { error: error.message });
      } else if (error instanceof EventNotFoundError) {
        sendJson(response, 404, { error: error.message });
      } else if (error instanceof EventAccessDeniedError || (error instanceof ApiError && error.status === 403)) {
        // The expense summary re-checks membership; a member removed mid-request also gets 403.
        sendJson(response, 403, { error: "You do not have access to this event" });
      } else {
        console.error("Event dashboard failed");
        sendJson(response, 500, { error: "Unable to load the event dashboard" });
      }
    }
  };
}
