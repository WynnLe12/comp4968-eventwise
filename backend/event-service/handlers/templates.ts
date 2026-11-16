import type { ServerResponse } from "node:http";
import { resolveTemplateRequest } from "../services/templates";
import { sendJson } from "../../shared/utils/http";

/** Returns false for paths/methods owned by other modules. */
export async function handleTemplates(method: string | undefined, path: string, response: ServerResponse): Promise<boolean> {
  const result = await resolveTemplateRequest(method, path);
  if (!result) return false;
  sendJson(response, result.statusCode, result.body);
  return true;
}
