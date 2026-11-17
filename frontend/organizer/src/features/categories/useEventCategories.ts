import { useEffect, useState } from "react";
import { fetchBudgetCategories, type BudgetCategory } from "../budgets/budgetApi";

export type CategoryOption = Pick<BudgetCategory, "categoryId" | "name">;

/** No cache across accounts/events. Late responses cannot replace the current options. */
export function useEventCategories(eventId: string | null, accountId: string) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([accountId, eventId, attempt]);
  const [snapshot, setSnapshot] = useState<{
    key: string; categories: CategoryOption[]; error: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (!eventId || !accountId) return;
    fetchBudgetCategories(eventId).then(result => {
      const ids = new Set<string>();
      if (result.eventId !== eventId || !Array.isArray(result.categories) ||
          result.categories.some(category => {
            if (category.eventId !== eventId || typeof category.categoryId !== "string" ||
                !/^[1-9][0-9]{0,19}$/.test(category.categoryId) || BigInt(category.categoryId) > 18446744073709551615n ||
                typeof category.name !== "string" || !category.name.trim() || ids.has(category.categoryId)) return true;
            ids.add(category.categoryId);
            return false;
          })) throw new Error("Invalid category response");
      if (active) setSnapshot({ key, categories: result.categories, error: "" });
    }).catch(() => {
      if (active) setSnapshot({ key, categories: [], error: "Couldn't load categories for this event." });
    });
    return () => { active = false; };
  }, [eventId, accountId, key]);

  const current = snapshot?.key === key ? snapshot : null;
  return {
    categories: current?.categories ?? [],
    loading: Boolean(eventId && accountId && !current),
    error: current?.error ?? "",
    retry: () => setAttempt(value => value + 1),
  };
}
