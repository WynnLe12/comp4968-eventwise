/**
 * Static placeholder content from the wireframe. The UI renders this until
 * real data sources are connected; there is no API or persistence here.
 */
import type { Expense, Guest, Money, VendorFields } from "../types";

export const CURRENT_EVENT_ID = "1";

export const budgetDefaults = [
  { name: "Venue & Catering", pct: 42, color: "#7958e8" },
  { name: "Photo & Video", pct: 14, color: "#ff6b9a" },
  { name: "Attire & Beauty", pct: 10, color: "#ffc857" },
  { name: "Flowers & Decor", pct: 12, color: "#ef73ac" },
  { name: "Music & Entertainment", pct: 9, color: "#51ad9a" },
  { name: "Stationery", pct: 5, color: "#5ca3e6" },
  { name: "Other", pct: 8, color: "#a6a9b6" },
];

/** Individual obligations linked by IDs, matching the vendor mock totals. */
export const expensesSeed: Expense[] = [
  { id: "1", eventId: CURRENT_EVENT_ID, vendorId: "1", vendor: "Venue deposit", category: "Venue & Catering", total: 5000, paid: 5000, due: "2027-01-15", dueDate: "2027-01-15", status: "Paid" },
  { id: "2", eventId: CURRENT_EVENT_ID, vendorId: "1", vendor: "Venue balance", category: "Venue & Catering", total: 7800, paid: 0, due: "2027-06-15", dueDate: "2027-06-15", status: "Unpaid" },
  { id: "3", eventId: CURRENT_EVENT_ID, vendorId: "2", vendor: "Photography package", category: "Photo & Video", total: 4200, paid: 2100, due: "2027-08-01", dueDate: "2027-08-01", status: "Partially paid" },
  { id: "4", eventId: CURRENT_EVENT_ID, vendorId: "3", vendor: "Florals", category: "Flowers & Decor", total: 2850, paid: 850, due: "2027-08-20", dueDate: "2027-08-20", status: "Deposit paid" },
  { id: "5", eventId: CURRENT_EVENT_ID, vendorId: "4", vendor: "Band", category: "Music & Entertainment", total: 1800, paid: 0, due: "2027-07-10", dueDate: "2027-07-10", status: "Unpaid" },
  { id: "6", eventId: CURRENT_EVENT_ID, vendorId: "5", vendor: "Invitations", category: "Stationery", total: 640, paid: 640, due: "2027-03-01", dueDate: "2027-03-01", status: "Paid" },
  { id: "7", eventId: CURRENT_EVENT_ID, vendorId: "6", vendor: "Cake tasting fee", category: "Cake & Desserts", total: 50, paid: 0, due: "No due date", dueDate: null, status: "Unpaid" },
  { id: "8", eventId: CURRENT_EVENT_ID, vendorId: "8", vendor: "Beauty package", category: "Attire & Beauty", total: 1200, paid: 300, due: "2027-09-05", dueDate: "2027-09-05", status: "Deposit paid" },
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

/** The event the organizer is viewing. IDs are strings of digits, like the API (event 1 in the DB seed). */

/** A vendor row as the mock service stores it: editable fields plus IDs and timestamps. */
export interface MockVendorRecord extends VendorFields {
  id: string;
  eventId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stand-in for the vendor's linked expenses (Feature 4). The mock service uses these
 * to produce paidTotal, balance and nextDueDate, and to block deleting a vendor with expenses.
 */
export interface MockVendorExpenses {
  paidTotal: Money;
  nextDueDate: string | null;
  /** Linked expenses, paid or not. */
  expenseCount: number;
}

const CREATED = "2026-11-02T18:00:00Z";

function seedVendor(
  id: string,
  fields: Partial<VendorFields> & Pick<VendorFields, "name">,
  expenses: Partial<MockVendorExpenses> = {},
): { record: MockVendorRecord; expenses: MockVendorExpenses } {
  return {
    record: {
      category: null,
      contactName: null,
      email: null,
      phone: null,
      quoteAmount: null,
      contractTotal: null,
      bookingStatus: "RESEARCHING",
      contractStatus: "NOT_STARTED",
      notes: null,
      ...fields,
      id,
      eventId: CURRENT_EVENT_ID,
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    expenses: { paidTotal: "0.00", nextDueDate: null, expenseCount: 0, ...expenses },
  };
}

/** Mock vendors for the vendor service, in the API's shape. */
export const vendorsSeed = [
  seedVendor(
    "1",
    {
      name: "The Willow House",
      category: "Venue & Catering",
      contactName: "Elena Brooks",
      email: "events@thewillowhouse.com",
      phone: "(555) 014-0182",
      quoteAmount: "12800.00",
      contractTotal: "12800.00",
      bookingStatus: "BOOKED",
      contractStatus: "SIGNED",
      notes: "Final headcount due 30 days before the event.",
    },
    { paidTotal: "5000.00", nextDueDate: "2027-06-15", expenseCount: 2 },
  ),
  seedVendor(
    "2",
    {
      name: "Lumen Photography",
      category: "Photo & Video",
      contactName: "Nora Kim",
      email: "hello@lumenphotography.com",
      phone: "(555) 013-7721",
      quoteAmount: "4200.00",
      contractTotal: "4200.00",
      bookingStatus: "BOOKED",
      contractStatus: "SIGNED",
      notes: "Includes engagement shoot.",
    },
    { paidTotal: "2100.00", nextDueDate: "2027-08-01", expenseCount: 1 },
  ),
  seedVendor(
    "3",
    {
      name: "Fleur & Fern",
      category: "Flowers & Decor",
      contactName: "Simone Reed",
      email: "hello@fleurandfern.com",
      phone: "(555) 018-4206",
      quoteAmount: "2850.00",
      contractTotal: "2850.00",
      bookingStatus: "QUOTED",
      contractStatus: "PENDING",
    },
    { paidTotal: "850.00", nextDueDate: "2027-08-20", expenseCount: 1 },
  ),
  seedVendor(
    "4",
    {
      name: "Blue Note Collective",
      category: "Music & Entertainment",
      contactName: "Marcus Bell",
      email: "bookings@bluenotecollective.com",
      phone: "(555) 019-6634",
      quoteAmount: "1800.00",
      contractTotal: "1800.00",
      bookingStatus: "QUOTED",
      contractStatus: "PENDING",
    },
    { nextDueDate: "2027-07-10", expenseCount: 1 },
  ),
  seedVendor(
    "5",
    {
      name: "Paperfolk Studio",
      category: "Stationery",
      contactName: "Avery Patel",
      email: "studio@paperfolkstudio.com",
      phone: "(555) 016-2048",
      quoteAmount: "640.00",
      contractTotal: "640.00",
      bookingStatus: "BOOKED",
      contractStatus: "SIGNED",
    },
    { paidTotal: "640.00", expenseCount: 1 },
  ),
  seedVendor(
    "6",
    {
      name: "Honeycrumb Bakery",
      category: "Cake & Desserts",
      contactName: "June Alvarez",
      email: "orders@honeycrumbbakery.com",
      phone: "(555) 015-8860",
      quoteAmount: "950.00",
      bookingStatus: "DECLINED",
      notes: "Tasting fee invoice still open.",
    },
    // An unpaid expense with no due date: nothing shows on the card, but it still blocks deletion.
    { expenseCount: 1 },
  ),
  seedVendor("7", {
    name: "Evergreen Coaches",
    category: "Transportation",
  }),
  seedVendor(
    "8",
    {
      name: "Sage Beauty Co.",
      category: "Attire & Beauty",
      contactName: "Camille Foster",
      email: "hello@sagebeautyco.com",
      phone: "(555) 012-3930",
      quoteAmount: "1200.00",
      contractTotal: "1200.00",
      bookingStatus: "BOOKED",
      contractStatus: "CANCELLED",
    },
    { paidTotal: "300.00", nextDueDate: "2027-09-05", expenseCount: 1 },
  ),
];
