import { getTemplate, listTemplates } from "../repositories/templates";

export interface TemplateRepository {
  listTemplates: typeof listTemplates;
  getTemplate: typeof getTemplate;
}

export interface TemplateResult {
  statusCode: number;
  body: object;
}

const repository: TemplateRepository = { listTemplates, getTemplate };

/** Shared routing, validation and response contract for HTTP and Lambda adapters. */
export async function resolveTemplateRequest(
  method: string | undefined,
  path: string,
  dependencies: TemplateRepository = repository,
): Promise<TemplateResult | undefined> {
  if (method !== "GET") return undefined;
  if (path === "/event-templates") {
    return { statusCode: 200, body: { templates: await dependencies.listTemplates() } };
  }
  const match = /^\/event-templates\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  const id = match[1];
  if (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
    return { statusCode: 400, body: { error: "templateId must be a positive unsigned BIGINT" } };
  }
  const template = await dependencies.getTemplate(id);
  return template
    ? { statusCode: 200, body: { template } }
    : { statusCode: 404, body: { error: "Template not found" } };
}
