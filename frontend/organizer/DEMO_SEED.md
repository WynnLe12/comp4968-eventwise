# Demo seed: vendors, expenses and payments

[`scripts/seed-demo-vendors.mjs`](scripts/seed-demo-vendors.mjs) fills one Cognito account with a demo wedding through the deployed API. It signs in the same way the app does, so the data belongs to that account and shows up when you sign in to the app with it.

It never touches the database directly. Every row goes through the API's validation, status rules and membership checks, so it's safe on the shared RDS database and can't change anyone else's events.

## Before you run it

- **The demo account exists and can sign in.** Sign in to the app with it once, and finish any first-login steps such as a new password or email confirmation. The script stops if Cognito asks for another step.
- **`frontend/organizer/.env` has the Cognito settings** (`VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`): the same file the app uses.
- **The events, budget categories, vendors and expenses routes are deployed** on the API. The default is `https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod`, the same API the dev proxy uses.
- **Node 22** (`nvm use 22`), and `npm ci` has been run in `frontend/organizer/`.

## Run it

From `frontend/organizer/`:

```bash
npm run seed:demo -- --dry-run
```

```bash
npm run seed:demo -- --email <demo account email>
```

The first command prints what would be created and sends nothing. The second asks for the password (it isn't shown or saved), then prints each vendor, expense and payment as it's created.

| Option                | What it does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--email <email>`     | Sign in as this account. Asks for the password                                                  |
| `--event-id <id>`     | Add everything to this existing event instead of the demo wedding                                |
| `--event-name <name>` | The name of the event to create or reuse. Default `Maya & Eli's Wedding`                         |
| `--new-event`         | Always create a new event, even if one with that name exists                                     |
| `--api <url>`         | Another API stage. You can also set `EVENTWISE_API_URL`                                          |
| `--dry-run`           | Print the plan and send nothing                                                                  |

Instead of `--email`, you can set `EVENTWISE_ACCESS_TOKEN` to an access token copied from a signed-in browser. In DevTools, look under Application → Local Storage for the key ending in `.accessToken`. Tokens expire after about an hour.

## What it creates

The event is **Maya & Eli's Wedding**: Wedding template, 2027-09-18, The Willow House, budget 35,000.00. The template gives it 7 budget categories, and each expense goes in the category with the same name as its vendor's category.

| Vendor               | Booking / contract   | Expenses (due date)                                     | Payments                 | Vendor shows: paid / balance |
| -------------------- | -------------------- | ------------------------------------------------------- | ------------------------ | ---------------------------- |
| The Willow House     | Booked / Signed      | Venue deposit 5,000 (2027-01-15), Venue balance 7,800 (2027-06-15) | 5,000 deposit            | 5,000 / 7,800                |
| Lumen Photography    | Booked / Signed      | Photography package 4,200 (2027-08-01)                  | 1,000 deposit, 1,100     | 2,100 / 2,100                |
| Fleur & Fern         | Booked / Signed      | Florals 2,850 (2027-08-20)                              | 850 deposit              | 850 / 2,000                  |
| Blue Note Collective | Booked / Signed      | Band 1,800 (2027-07-10)                                 | none                     | 0 / 1,800                    |
| Paperfolk Studio     | Booked / Signed      | Invitations 640 (2027-03-01)                            | 640, paid in full        | 640 / 0                      |
| Silk & Thread Bridal | Quoted / Pending     | Wedding dress 2,700 (2027-06-01), Dress alterations 400 (no due date) | none | 0 / 3,100                    |
| Golden Hour Cars     | Declined / Cancelled | none                                                    | none                     | 0 / none                     |
| Rosewood Rentals     | Researching / Not started | none                                               | none                     | 0 / none                     |

It also adds one expense with no vendor: **Marriage licence**, 150, paid in full.

For every vendor with a contract and expenses, the expenses add up to the contract total, so no card shows "Contract and expense totals differ." A test checks this.

This matches `database/mysql/seeds/02_vendors_seed.sql` except for two things:

- Fleur & Fern's 1,000 deposit and 150 refund are a single 850 deposit, because the API can't record refunds.
- Silk & Thread Bridal has an extra "Wedding dress" 2,700 expense, so its expenses match its 3,100 contract.

If you seeded an account before this change, running the script again won't add the dress, because it skips vendors that already exist. Add the 2,700 "Wedding dress" expense to Silk & Thread in the app instead.

## Running it more than once

Running it again is safe. Each run looks only at the signed-in account's own events, and it never duplicates anything inside an event:

- **The event:** it reuses the account's event with the same name. If the account has two events with that name, it stops and asks you to pick one with `--event-id`.
- **Vendors:** it skips any vendor whose name is already in the event, along with that vendor's expenses.
- **Expenses:** it skips any expense whose description is already in the event.
- **Payments:** it only records payments for expenses it created in that run.

| Scenario | What happens |
| --- | --- |
| Same account, same command again | Nothing new. It reuses the event and skips every vendor and expense |
| Same account, a run stopped partway (for example the token expired) | Run it again. It fills in only what's missing |
| Same account, `--event-name "<other name>"` | A second, separate event with the full demo data |
| Same account, `--new-event` | Another event with the same name and the full demo data. Later runs without `--event-id` then stop, because two events share the name |
| Different account, same command | A separate copy for that account, with the same event and vendor names. It can't see the first account's event, so it creates its own |
| Different account that's a co-planner on the first account's wedding | It can see that event, so it reuses it and adds nothing |

**Duplicate names across accounts are fine.** The database doesn't require event or vendor names to be unique: every row has its own ID and belongs to one event. Each account sees only its own events in the app, and changing one copy never affects another.

## Removing the demo data

**The app can't delete an event once it has payments**, and the API has no way to delete a payment. So you can't undo a seed from the app. Either:

- run it again with `--new-event --event-name "<another name>"` to get a fresh copy alongside the old one, or
- ask whoever manages the RDS database to delete the event.

Rehearse with a throwaway name first, for example `--event-name "Seed test"`, if you're worried about leaving a messy demo account.

## Tests

[`scripts/seedDemoVendors.test.mjs`](scripts/seedDemoVendors.test.mjs) runs the seed against an in-memory fake API. It covers the first run, a second run, recovery after a partial failure, `--new-event`, an event with no categories, and error messages:

```bash
node --test scripts/seedDemoVendors.test.mjs
```
