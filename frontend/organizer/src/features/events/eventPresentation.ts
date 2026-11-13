import type { OrganizerEvent } from "./services/eventApi";

export function eventRole(role: OrganizerEvent["role"]) {
  return role === "OWNER" ? "Owner" : "Co-planner";
}
export function eventDate(date: string | null) {
  if (!date) return "Date not set";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
export function eventInitials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] ?? "").join("").toUpperCase();
}
