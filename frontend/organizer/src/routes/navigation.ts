import type { Page } from "../types";

export const navGroups: { label: string; items: { id: Page; label: string; icon: string }[] }[] = [
  {
    label: "Plan",
    items: [
      { id: "dashboard", label: "Dashboard", icon: "grid" },
      { id: "events", label: "My events", icon: "calendar" },
      { id: "tasks", label: "Tasks", icon: "check" },
      { id: "timeline", label: "Timeline", icon: "clock" },
    ],
  },
  {
    label: "Manage",
    items: [
      { id: "budget", label: "Budget", icon: "wallet" },
      { id: "expenses", label: "Expenses", icon: "receipt" },
      { id: "vendors", label: "Vendors", icon: "store" },
      { id: "guests", label: "Guests", icon: "users" },
      { id: "invitations", label: "Invitations & RSVP", icon: "mail" },
      { id: "documents", label: "Documents", icon: "file" },
    ],
  },
  {
    label: "More",
    items: [
      { id: "templates", label: "Templates", icon: "spark" },
      { id: "coplanners", label: "Co-planners", icon: "userplus" },
      { id: "photos", label: "Photo gallery", icon: "image" },
      { id: "contracts", label: "Contract extraction", icon: "scan" },
      { id: "alerts", label: "Alerts", icon: "bell" },
    ],
  },
];

export const pageTitles: Record<Page, [string, string]> = {
  dashboard: ["Good morning, Maya", "Here’s what’s happening with your wedding."],
  events: ["My events", "Create, edit, and switch between all your celebrations."],
  coplanners: ["Co-planners", "Bring your planning team together and manage their access."],
  budget: ["Budget", "Keep every dollar intentional and your plans on track."],
  expenses: ["Expenses", "Track deposits, balances, and every payment in one place."],
  vendors: ["Vendors", "Keep contacts, quotes, contracts, and due dates organized."],
  documents: ["Documents", "All your event files, neatly organized and ready to share."],
  guests: ["Guest list", "Manage households, plus-ones, meals, and RSVPs."],
  invitations: ["Invitations & RSVP", "Design your invitation and collect guest responses."],
  alerts: ["Alerts", "Important payment reminders and budget updates."],
  templates: ["Event templates", "Start with smart defaults, then make the plan your own."],
  tasks: ["Tasks", "A shared checklist to keep planning moving forward."],
  timeline: ["Event timeline", "Build a smooth schedule for your team and guests."],
  photos: ["QR photo gallery", "Collect guest photos and approve the best moments."],
  contracts: ["Contract extraction", "Turn vendor contracts into clear dates, costs, and actions."],
};

export const pagePath = (page: Page) => `/app/${page}`;
