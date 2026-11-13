import type { TemplateResponse, TemplatesResponse } from "../types/eventTemplates";

import { apiUrl } from "./apiConfig";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), { signal });
  if (!response.ok) throw new Error(`Template request failed (${response.status})`);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The template API did not return JSON");
  }
  return response.json() as Promise<T>;
}

export async function listEventTemplates(signal?: AbortSignal) {
  return (await getJson<TemplatesResponse>("/event-templates", signal)).templates;
}

export async function getEventTemplate(id: string, signal?: AbortSignal) {
  return (await getJson<TemplateResponse>(`/event-templates/${encodeURIComponent(id)}`, signal)).template;
}
