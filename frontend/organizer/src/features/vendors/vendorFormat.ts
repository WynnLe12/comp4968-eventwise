import type { BookingStatus, Money, Vendor } from "../../types";

const currencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dueDateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit" });

/** "$1,800.00" for an API money string ("1800.00"), or "—" when there is no value. */
export function currency(value: Money | null) {
  return value === null ? "—" : currencyFormat.format(Number(value));
}

/** "Jul 10" for an ISO date, or "None". */
export function dueDateLabel(isoDate: string | null) {
  if (!isoDate) return "None";
  // Noon avoids the date shifting a day in time zones west of UTC.
  return dueDateFormat.format(new Date(`${isoDate}T12:00:00`));
}

/** First letters of the first two words that start with a letter: "Fleur & Fern" -> "FF". */
export function initials(name: string) {
  const letters = name
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]);
  return (letters.join("") || name.trim().charAt(0) || "?").toUpperCase();
}

const AVATAR_TONES = ["purple", "coral", "pink", "blue", "gold"];

/** A stable avatar colour per vendor, so colours don't shift when the list changes. */
export function avatarTone(vendorId: string) {
  let hash = 0;
  for (const char of vendorId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function bookingTone(status: BookingStatus) {
  if (status === "BOOKED") return "success";
  if (status === "DECLINED") return "danger";
  return "warning";
}

/** Card footer: the next due date, or "Paid" once the contract is fully paid (or overpaid). */
export function nextDueLabel(vendor: Vendor) {
  if (vendor.nextDueDate) return dueDateLabel(vendor.nextDueDate);
  if (vendor.balance !== null && Number(vendor.balance) <= 0) return "Paid";
  return "None";
}

/** True when the vendor has been paid more than its contract total. */
export function isOverpaid(vendor: Vendor) {
  return vendor.balance !== null && Number(vendor.balance) < 0;
}
