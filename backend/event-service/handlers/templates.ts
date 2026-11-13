import type { ServerResponse } from "node:http";
import { getTemplate, listTemplates } from "../repositories/templates";
import { sendJson } from "../../shared/utils/http";

/** Returns false for paths/methods owned by other modules. */
export async function handleTemplates(method: string | undefined, path: string, response: ServerResponse): Promise<boolean> {
  if (method !== "GET") return false;
  if (path === "/event-templates") {
    sendJson(response, 200, { templates: await listTemplates() });
    return true;
  }
  const match = /^\/event-templates\/([^/]+)$/.exec(path);
  if (!match) return false;
  const id = match[1];
  if (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
    sendJson(response, 400, { error: "templateId must be a positive unsigned BIGINT" });
    return true;
  }
  const template = await getTemplate(id);
  if (!template) sendJson(response, 404, { error: "Template not found" });
  else sendJson(response, 200, { template });
  return true;
}
