
export interface BudgetCategory {
  categoryId: string;
  eventId: string;
  name: string;
  allocationPercentage: string | null;
  plannedAmount: string;
  sortOrder: number;
}

export interface EventBudgetResponse {
  eventId: string;
  totalBudget: string;
  categories: BudgetCategory[];
}

export interface BudgetCategoryInput {
  name: string;
  allocationPercentage: string | null;
  plannedAmount: string;
  sortOrder: number;
}

// API Gateway URL in AWS, or local backend URL during development.
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000";

// Make a request to the backend.
async function budgetRequest<T>(
  path: string,
  method: string = "GET",
  body?: unknown,
  accessToken?: string
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : {}),
    },
    ...(body !== undefined
      ? { body: JSON.stringify(body) }
      : {}),
  });

  const result: unknown = await response.json();

  if (!response.ok) {
    const error = result as { error?: string };

    throw new Error(
      error.error ?? `Request failed (${response.status})`
    );
  }

  return result as T;
}

// GET /events/:eventId/budget-categories
export function fetchBudgetCategories(
  eventId: string,
  accessToken?: string
): Promise<EventBudgetResponse> {
  return budgetRequest<EventBudgetResponse>(
    `/events/${encodeURIComponent(eventId)}/budget-categories`,
    "GET",
    undefined,
    accessToken
  );
}

// POST /events/:eventId/budget-categories
export function addBudgetCategory(
  eventId: string,
  input: BudgetCategoryInput,
  accessToken?: string
): Promise<{ categoryId: string; message: string }> {
  return budgetRequest(
    `/events/${encodeURIComponent(eventId)}/budget-categories`,
    "POST",
    input,
    accessToken
  );
}

// PATCH /events/:eventId/budget-categories/:categoryId
export function editBudgetCategory(
  eventId: string,
  categoryId: string,
  input: BudgetCategoryInput,
  accessToken?: string
): Promise<{ message: string }> {
  return budgetRequest(
    `/events/${encodeURIComponent(eventId)}/budget-categories/${encodeURIComponent(categoryId)}`,
    "PATCH",
    input,
    accessToken
  );
}

// DELETE /events/:eventId/budget-categories/:categoryId
export function removeBudgetCategory(
  eventId: string,
  categoryId: string,
  accessToken?: string
): Promise<{ message: string }> {
  return budgetRequest(
    `/events/${encodeURIComponent(eventId)}/budget-categories/${encodeURIComponent(categoryId)}`,
    "DELETE",
    undefined,
    accessToken
  );
}
