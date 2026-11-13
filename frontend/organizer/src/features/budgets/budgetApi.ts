import { apiUrl } from "../../services/apiConfig";
import { requireAuthSession } from "../auth/services/authService";

// Represents a budget category returned by MySQL.
export interface BudgetCategory {
  categoryId: string;
  eventId: string;
  name: string;
  allocationPercentage: string | null;
  plannedAmount: string;
  sortOrder: number;
}

// Response from GET /events/:eventId/budget-categories.
export interface EventBudgetResponse {
  eventId: string;
  totalBudget: string;
  categories: BudgetCategory[];
}

// Data sent when creating or updating a category.
export interface BudgetCategoryInput {
  name: string;
  allocationPercentage: string | null;
  plannedAmount: string;
  sortOrder: number;
}

export interface BudgetTotalCategoryUpdate {
  categoryId: string;
  allocationPercentage: string;
  plannedAmount: string;
}

export interface BudgetTotalUpdateInput {
  totalBudget: string;
  categories: BudgetTotalCategoryUpdate[];
}

// Shared request function for Feature 3.
async function budgetRequest<T>(
  path: string,
  method: string = "GET",
  body?: unknown,
  _accessToken?: string
): Promise<T> {
  // Use Wynn's existing Cognito authentication system.
  const identity = await requireAuthSession();

  const token = identity.session.tokens?.accessToken;

  if (!token) {
    throw new Error("Your session has expired. Please sign in again.");
  }

  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${token.toString()}`,
      ...(body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(body !== undefined
      ? { body: JSON.stringify(body) }
      : {}),
  });

  const result: unknown = await response
    .json()
    .catch(() => null);

  if (response.status === 401) {
    throw new Error("Your session has expired. Please sign in again.");
  }

  if (!response.ok) {
    const error =
      result !== null && typeof result === "object" ? (result as { error?: string }) : null;

    throw new Error(error?.error ?? `Request failed (${response.status})`);
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

/**
 * Updates the event's total budget and existing category allocations
 * in one database transaction.
 *
 * Only the event OWNER can perform this operation.
 */
export function saveTotalBudget(
  eventId: string,
  input: BudgetTotalUpdateInput
): Promise<{ message: string }> {
  return budgetRequest<{ message: string }>(
    `/events/${encodeURIComponent(eventId)}/budget`,
    "PATCH",
    input
  );
}
