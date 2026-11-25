// Task progress
import type { Progress } from "../types";

/**
 * Counts may arrive as strings (bigNumberStrings). 0 tasks is 0%, never NaN.
 * Rounds to the nearest whole percent, the same as the Feature 10 dashboard
 * (event-service/services/dashboardService.ts), so both pages show the same number.
 */
export function toProgress(total: unknown, completed: unknown): Progress {
  const t = Number(total ?? 0);
  const c = Number(completed ?? 0);
  return { total: t, completed: c, open: t - c, percentComplete: t === 0 ? 0 : Math.round((c / t) * 100) };
}
