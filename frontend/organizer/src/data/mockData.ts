/**
 * Static placeholder content from the wireframe. The UI renders this until
 * real data sources are connected; there is no API or persistence here.
 */
import type { Expense, Guest } from "../types";

export const budgetDefaults = [
  { name: "Venue & Catering", pct: 42, color: "#7958e8" },
  { name: "Photo & Video", pct: 14, color: "#ff6b9a" },
  { name: "Attire & Beauty", pct: 10, color: "#ffc857" },
  { name: "Flowers & Decor", pct: 12, color: "#ef73ac" },
  { name: "Music & Entertainment", pct: 9, color: "#51ad9a" },
  { name: "Stationery", pct: 5, color: "#5ca3e6" },
  { name: "Other", pct: 8, color: "#a6a9b6" },
];

export const expensesSeed: Expense[] = [
  {
    id: "sample-the-willow-house",
    vendor: "The Willow House",
    category: "Venue & Catering",
    total: 12800,
    paid: 5000,
    due: "Jun 15",
    status: "Partially paid",
  },
  {
    id: "sample-lumen-photography",
    vendor: "Lumen Photography",
    category: "Photo & Video",
    total: 4200,
    paid: 2100,
    due: "Aug 01",
    status: "Partially paid",
  },
  {
    id: "sample-fleur-&-fern",
    vendor: "Fleur & Fern",
    category: "Flowers & Decor",
    total: 2850,
    paid: 850,
    due: "Aug 20",
    status: "Deposit paid",
  },
  {
    id: "sample-blue-note-collective",
    vendor: "Blue Note Collective",
    category: "Music & Entertainment",
    total: 1800,
    paid: 0,
    due: "Jul 10",
    status: "Unpaid",
  },
  {
    id: "sample-paperfolk-studio",
    vendor: "Paperfolk Studio",
    category: "Stationery",
    total: 640,
    paid: 640,
    due: "Paid",
    status: "Paid",
  },
];

export const guestsSeed: Guest[] = [
  {
    name: "Olivia & Noah Bennett",
    group: "Maya’s family",
    party: 2,
    rsvp: "Attending",
    meal: "1 chicken, 1 salmon",
  },
  {
    name: "Sofia Martinez",
    group: "College friends",
    party: 2,
    rsvp: "Awaiting",
    meal: "Not selected",
  },
  { name: "James Chen", group: "Eli’s family", party: 1, rsvp: "Attending", meal: "Vegetarian" },
  { name: "Amelia Wilson", group: "Work friends", party: 1, rsvp: "Declined", meal: "—" },
  {
    name: "Henry & Claire Davis",
    group: "Family friends",
    party: 2,
    rsvp: "Attending",
    meal: "2 salmon",
  },
];
