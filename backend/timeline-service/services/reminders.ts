// Reminder timing for timeline activities (Feature 13, US42). Rules: docs/api/timeline.md, section 7.
//
// reminderAt = startsAt − reminderMinutes. No reminder is scheduled when reminderMinutes is 0
// or when that moment has already passed at save time (sending a late "starts in 1 hour"
// email would be wrong). The reminder Lambda only picks up PENDING items whose reminderAt <= now.

import type { ReminderMinutes, TimelineFields } from "../types";
import { toUtcInstant } from "./validation";

/** When the reminder should go out, or null when there should be none. */
export function calculateReminderAt(startsAt: string, reminderMinutes: ReminderMinutes, now: Date): string | null {
  if (reminderMinutes === 0) return null;
  const at = Date.parse(startsAt) - reminderMinutes * 60_000;
  if (Number.isNaN(at) || at <= now.getTime()) return null;
  return toUtcInstant(new Date(at));
}

type Timing = Pick<TimelineFields, "startsAt" | "reminderMinutes">;

/**
 * For a PATCH: the new reminderAt when the activity moved or its reminder setting changed,
 * or undefined to leave the stored reminder (and its sent mark) untouched.
 * A string reschedules the reminder; null cancels it.
 */
export function rescheduleReminder(before: Timing, after: Timing, now: Date): string | null | undefined {
  if (before.startsAt === after.startsAt && before.reminderMinutes === after.reminderMinutes) return undefined;
  return calculateReminderAt(after.startsAt, after.reminderMinutes, now);
}

/** Text for emails and the UI, e.g. "1 hour before". */
export function describeReminder(reminderMinutes: ReminderMinutes): string {
  switch (reminderMinutes) {
    case 0: return "No reminder";
    case 15: return "15 minutes before";
    case 60: return "1 hour before";
    case 1440: return "1 day before";
  }
}
