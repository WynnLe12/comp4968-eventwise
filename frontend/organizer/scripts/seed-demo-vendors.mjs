#!/usr/bin/env node
// Seeds a demo wedding with vendors, expenses and payments for one Cognito user,
// through the deployed EventWise API (never straight into the database). Every
// row goes through the same validation and membership checks as the app.
//
//   npm run seed:demo -- --email demo@example.com      sign in (password prompt)
//   npm run seed:demo -- --dry-run                     show the plan, send nothing
//
// See DEMO_SEED.md for the options and what gets created.
//
// Safe to run again: it reuses the event with the same name, skips vendors and
// expenses that already exist by name/description, and only records payments for
// expenses it created in this run.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_API_URL = "https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod";

// ---------------------------------------------------------------------------
// Demo data. Mirrors database/mysql/seeds/02_vendors_seed.sql (event 1), minus the
// refund: the API only records deposits and payments.
// Payment dates must not be in the future (the API rejects them).

export const DEMO_EVENT = {
  name: "Maya & Eli's Wedding",
  templateKey: "wedding",
  event_date: "2027-09-18",
  venue: "The Willow House",
  total_budget: "35000.00",
};

/**
 * Each vendor is POSTed as-is. The server's status rules turn a quote into QUOTED
 * and a signed contract into BOOKED. `expenses` link to the event's budget
 * category with the same name as the vendor's category.
 */
export const DEMO_VENDORS = [
  {
    vendor: {
      name: "The Willow House", category: "Venue & Catering", contactName: "Grace Hill",
      email: "events@thewillowhouse.example", phone: "(555) 014-2280",
      quoteAmount: "12800.00", contractStatus: "SIGNED", contractTotal: "12800.00",
      notes: "Final headcount due 30 days before the event.",
    },
    expenses: [
      { description: "Venue deposit", committedAmount: "5000.00", dueDate: "2027-01-15",
        payments: [{ amount: "5000.00", paidAt: "2026-10-01", paymentType: "DEPOSIT", notes: "Venue deposit" }] },
      { description: "Venue balance", committedAmount: "7800.00", dueDate: "2027-06-15", payments: [] },
    ],
  },
  {
    vendor: {
      name: "Lumen Photography", category: "Photo & Video", contactName: "Daniel Park",
      email: "hello@lumenphoto.example", phone: "(555) 014-3391",
      quoteAmount: "4200.00", contractStatus: "SIGNED", contractTotal: "4200.00",
      notes: "Includes engagement shoot.",
    },
    expenses: [
      { description: "Photography package", committedAmount: "4200.00", dueDate: "2027-08-01",
        payments: [
          { amount: "1000.00", paidAt: "2026-10-05", paymentType: "DEPOSIT", notes: null },
          { amount: "1100.00", paidAt: "2026-11-02", paymentType: "PAYMENT", notes: null },
        ] },
    ],
  },
  {
    vendor: {
      name: "Fleur & Fern", category: "Flowers & Decor", contactName: "Priya Shah",
      email: "studio@fleurandfern.example", phone: "(555) 014-4402",
      quoteAmount: "2850.00", contractStatus: "SIGNED", contractTotal: "2850.00",
      notes: "Ceremony arch removed from the order.",
    },
    expenses: [
      { description: "Florals", committedAmount: "2850.00", dueDate: "2027-08-20",
        payments: [{ amount: "850.00", paidAt: "2026-10-12", paymentType: "DEPOSIT", notes: null }] },
    ],
  },
  {
    vendor: {
      name: "Blue Note Collective", category: "Music & Entertainment", contactName: "Marcus Reid",
      email: "bookings@bluenote.example", phone: "(555) 014-5513",
      quoteAmount: "1800.00", contractStatus: "SIGNED", contractTotal: "1800.00", notes: null,
    },
    expenses: [{ description: "Band", committedAmount: "1800.00", dueDate: "2027-07-10", payments: [] }],
  },
  {
    vendor: {
      name: "Paperfolk Studio", category: "Stationery", contactName: "Lena Novak",
      email: "hi@paperfolk.example", phone: null,
      quoteAmount: "640.00", contractStatus: "SIGNED", contractTotal: "640.00",
      notes: "Invitations and place cards.",
    },
    expenses: [
      { description: "Invitations", committedAmount: "640.00", dueDate: "2027-03-01",
        payments: [{ amount: "640.00", paidAt: "2026-10-15", paymentType: "PAYMENT", notes: "Paid in full" }] },
    ],
  },
  {
    vendor: {
      name: "Silk & Thread Bridal", category: "Attire & Beauty", contactName: "Ana Ruiz",
      email: "appointments@silkandthread.example", phone: "(555) 014-6624",
      quoteAmount: "3200.00", contractStatus: "PENDING", contractTotal: "3100.00",
      notes: "Contract sent with a 100.00 discount.",
    },
    // Adds up to the 3,100.00 contract total, so the card shows no totals mismatch.
    expenses: [
      { description: "Wedding dress", committedAmount: "2700.00", dueDate: "2027-06-01", payments: [] },
      { description: "Dress alterations", committedAmount: "400.00", dueDate: null, payments: [] },
    ],
  },
  {
    vendor: {
      name: "Golden Hour Cars", category: "Other", contactName: "Tom Baker",
      email: null, phone: "(555) 014-7735",
      quoteAmount: "950.00", bookingStatus: "DECLINED", contractStatus: "CANCELLED",
      notes: "Marked as cancelled; went with the venue's shuttle.",
    },
    expenses: [],
  },
  {
    vendor: { name: "Rosewood Rentals", category: "Other" },
    expenses: [],
  },
];

/** Expenses with no vendor, so the Expenses page shows one. */
export const DEMO_OTHER_EXPENSES = [
  { category: "Other", description: "Marriage licence", committedAmount: "150.00", dueDate: "2027-05-01",
    payments: [{ amount: "150.00", paidAt: "2026-11-01", paymentType: "PAYMENT", notes: "City hall fee" }] },
];

// ---------------------------------------------------------------------------
// Small helpers

const here = dirname(fileURLToPath(import.meta.url));

/** Reads KEY=value lines from frontend/organizer/.env, if it exists. */
export function readDotEnv() {
  try {
    const values = {};
    for (const line of readFileSync(join(here, "..", ".env"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return values;
  } catch {
    return {};
  }
}

export class ApiRequestError extends Error {
  constructor(method, path, status, body) {
    const detail = body?.error?.message ?? body?.error ?? body?.message ?? "";
    const fields = body?.error?.fields ? ` ${JSON.stringify(body.error.fields)}` : "";
    super(`${method} ${path} failed with ${status}${detail ? `: ${detail}` : ""}${fields}`);
    this.status = status;
    this.body = body;
  }
}

/** A tiny JSON client for the EventWise API. */
export function createApi(baseUrl, accessToken, fetchImpl = fetch) {
  const base = baseUrl.replace(/\/$/, "");
  return async function api(method, path, body) {
    const response = await fetchImpl(base + path, {
      method,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      if (response.status === 401) {
        throw new ApiRequestError(method, path, 401, { message: "not signed in or the token expired. Sign in again." });
      }
      throw new ApiRequestError(method, path, response.status, parsed);
    }
    return parsed;
  };
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error("A password prompt needs an interactive terminal.");
  return new Promise((resolve, reject) => {
    let value = "";
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

/** Signs in with Amplify (SRP, the same flow as the organizer app) and returns the access token. */
export async function signInForAccessToken(email, env) {
  const userPoolId = env.VITE_COGNITO_USER_POOL_ID?.trim();
  const userPoolClientId = env.VITE_COGNITO_CLIENT_ID?.trim();
  if (!userPoolId || !userPoolClientId) {
    throw new Error("Set VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID in frontend/organizer/.env (same values the app uses).");
  }
  const { Amplify } = await import("aws-amplify");
  const auth = await import("aws-amplify/auth");
  Amplify.configure({ Auth: { Cognito: { userPoolId, userPoolClientId } } });

  const password = await promptHidden(`Password for ${email}: `);
  const result = await auth.signIn({ username: email, password });
  if (!result.isSignedIn) {
    throw new Error(`Sign-in needs another step (${result.nextStep?.signInStep}). Finish it in the app first, then run this again.`);
  }
  const token = (await auth.fetchAuthSession()).tokens?.accessToken?.toString();
  if (!token) throw new Error("Signed in, but Cognito returned no access token.");
  return token;
}

// ---------------------------------------------------------------------------
// The seed itself

/**
 * @param api     from createApi
 * @param options { eventId?: string, eventName?: string, newEvent?: boolean, log?: (line) => void }
 * @returns a summary of what was created and skipped
 */
export async function seedDemo(api, options = {}) {
  const log = options.log ?? console.log;
  const summary = { eventId: null, eventCreated: false, vendorsCreated: 0, vendorsSkipped: 0,
    expensesCreated: 0, expensesSkipped: 0, paymentsRecorded: 0, warnings: [] };
  const warn = (message) => { summary.warnings.push(message); log(`  ! ${message}`); };

  // 1. The event: the one given, an existing one with the demo name, or a new one.
  const eventName = options.eventName ?? DEMO_EVENT.name;
  let eventId = options.eventId ?? null;
  if (eventId === null && !options.newEvent) {
    const events = await api("GET", "/events");
    const matches = events.filter((event) => event.name === eventName);
    if (matches.length > 1) {
      throw new Error(`You have ${matches.length} events named "${eventName}". Pick one with --event-id ${matches.map((e) => e.event_id).join(" or ")}.`);
    }
    if (matches.length === 1) {
      eventId = matches[0].event_id;
      log(`Using your existing event "${eventName}" (id ${eventId}).`);
    }
  }
  if (eventId === null) {
    const { templates } = await api("GET", "/event-templates");
    const template = templates.find((t) => t.templateKey === DEMO_EVENT.templateKey);
    if (!template) warn(`No "${DEMO_EVENT.templateKey}" template, so the event starts with no budget categories.`);
    const event = await api("POST", "/events", {
      name: eventName,
      template_id: template?.templateId ?? null,
      event_date: DEMO_EVENT.event_date,
      venue: DEMO_EVENT.venue,
      total_budget: DEMO_EVENT.total_budget,
    });
    eventId = event.event_id;
    summary.eventCreated = true;
    log(`Created event "${eventName}" (id ${eventId}).`);
  } else if (options.eventId) {
    log(`Using event id ${eventId}.`);
  }
  summary.eventId = eventId;
  const eventPath = `/events/${encodeURIComponent(eventId)}`;

  // 2. What's already there, so a second run doesn't make duplicates.
  const existingVendors = new Map((await api("GET", `${eventPath}/vendors`)).map((v) => [v.name, v]));
  const existingExpenses = new Set();
  for (let offset = 0; ; offset += 100) {
    const page = await api("GET", `${eventPath}/expenses?limit=100&offset=${offset}`);
    for (const expense of page.data) existingExpenses.add(expense.description);
    if (offset + page.data.length >= page.total || page.data.length === 0) break;
  }
  const budget = await api("GET", `${eventPath}/budget-categories`);
  const categories = new Map((budget.categories ?? []).map((c) => [c.name, c.categoryId]));

  const categoryFor = (name) => {
    if (categories.has(name)) return categories.get(name);
    if (categories.has("Other")) return categories.get("Other");
    return categories.values().next().value ?? null;
  };

  async function addExpense(spec, vendorId, label) {
    if (existingExpenses.has(spec.description)) {
      summary.expensesSkipped++;
      log(`    = expense "${spec.description}" already exists, skipped`);
      return;
    }
    const categoryId = categoryFor(spec.category);
    if (categoryId === null) {
      warn(`Event has no budget categories, so expense "${spec.description}" was not added.`);
      return;
    }
    const { data: expense } = await api("POST", `${eventPath}/expenses`, {
      categoryId, vendorId, description: spec.description,
      committedAmount: spec.committedAmount, dueDate: spec.dueDate,
    });
    existingExpenses.add(spec.description);
    summary.expensesCreated++;
    log(`    + expense "${spec.description}" ${spec.committedAmount}${label}`);
    for (const payment of spec.payments) {
      await api("POST", `${eventPath}/expenses/${encodeURIComponent(expense.expenseId)}/payments`, payment);
      summary.paymentsRecorded++;
      log(`      + ${payment.paymentType.toLowerCase()} ${payment.amount} on ${payment.paidAt}`);
    }
  }

  // 3. Vendors, each followed by its expenses and payments.
  for (const { vendor: spec, expenses } of DEMO_VENDORS) {
    if (existingVendors.has(spec.name)) {
      summary.vendorsSkipped++;
      log(`  = vendor "${spec.name}" already exists, skipped (and its expenses)`);
      continue;
    }
    const vendor = await api("POST", `${eventPath}/vendors`, spec);
    summary.vendorsCreated++;
    log(`  + vendor "${vendor.name}" (${vendor.bookingStatus} / ${vendor.contractStatus})`);
    for (const expense of expenses) {
      await addExpense({ ...expense, category: spec.category }, String(vendor.id), "");
    }
  }

  // 4. Expenses with no vendor.
  for (const expense of DEMO_OTHER_EXPENSES) {
    await addExpense(expense, null, " (no vendor)");
  }

  return summary;
}

function printPlan(log = console.log) {
  log(`Dry run: nothing is sent. A run would create (or reuse) "${DEMO_EVENT.name}" and add:`);
  for (const { vendor, expenses } of DEMO_VENDORS) {
    log(`  vendor "${vendor.name}" (${vendor.category})`);
    for (const e of expenses) {
      const paid = e.payments.map((p) => `${p.paymentType.toLowerCase()} ${p.amount}`).join(", ");
      log(`    expense "${e.description}" ${e.committedAmount}${e.dueDate ? ` due ${e.dueDate}` : ""}${paid ? `, paid: ${paid}` : ""}`);
    }
  }
  for (const e of DEMO_OTHER_EXPENSES) log(`  expense "${e.description}" ${e.committedAmount} (no vendor)`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      "event-id": { type: "string" },
      "event-name": { type: "string" },
      "new-event": { type: "boolean", default: false },
      api: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: npm run seed:demo -- [--email <email>] [options]

  --email <email>     Sign in as this Cognito user (asks for the password)
  --event-id <id>     Add to this existing event instead of the demo wedding
  --event-name <name> Name of the event to create or reuse (default "${DEMO_EVENT.name}")
  --new-event         Always create a new event, even if one with that name exists
  --api <url>         API base URL (default EVENTWISE_API_URL, then ${DEFAULT_API_URL})
  --dry-run           Print what would be created and send nothing

Instead of --email you can set EVENTWISE_ACCESS_TOKEN to a Cognito access token.`);
    return;
  }
  if (values["dry-run"]) return printPlan();
  if (values["event-id"] && !/^[1-9][0-9]{0,19}$/.test(values["event-id"])) {
    throw new Error("--event-id must be a positive whole number.");
  }

  const env = { ...readDotEnv(), ...process.env };
  const baseUrl = values.api ?? env.EVENTWISE_API_URL ?? DEFAULT_API_URL;
  const email = values.email ?? env.EVENTWISE_EMAIL;
  let token = env.EVENTWISE_ACCESS_TOKEN?.trim();
  if (!token) {
    if (!email) throw new Error("Pass --email <demo account email>, or set EVENTWISE_ACCESS_TOKEN. Run with --help for details.");
    token = await signInForAccessToken(email, env);
    console.log(`Signed in as ${email}.`);
  }

  console.log(`API: ${baseUrl}`);
  const summary = await seedDemo(createApi(baseUrl, token), {
    eventId: values["event-id"] ?? null,
    eventName: values["event-name"],
    newEvent: values["new-event"],
  });
  console.log(`\nDone. Event id ${summary.eventId}${summary.eventCreated ? " (new)" : ""}: ` +
    `${summary.vendorsCreated} vendors added, ${summary.vendorsSkipped} skipped; ` +
    `${summary.expensesCreated} expenses added, ${summary.expensesSkipped} skipped; ` +
    `${summary.paymentsRecorded} payments recorded.`);
  if (summary.warnings.length) console.log(`${summary.warnings.length} warning(s) above.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), (error) => {
    console.error(`\nSeed stopped: ${error.message}`);
    process.exit(1);
  });
}
