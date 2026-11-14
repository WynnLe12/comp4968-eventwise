const calendarDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Formats date-only values without shifting the calendar day between time zones. */
export function formatCalendarDate(value: string | null | undefined, emptyLabel = "None"): string {
  if (!value) return emptyLabel;
  // Preserve existing labels such as "Paid" and "No due date".
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value + "T00:00:00Z");
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return emptyLabel;
  return calendarDateFormat.format(date);
}
