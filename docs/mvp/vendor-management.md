# Feature 5: Vendor management

Related documents:

- API contract: [docs/api/vendors.md](../api/vendors.md), with the routes, JSON shape, rules and error codes the frontend and backend both build against
- Schema: [database/mysql/schemas/eventwise_schema.sql](../../database/mysql/schemas/eventwise_schema.sql), with the `vendors` table and the `vendor_payment_totals` view
- Team source: _EventWise Features, Tasks & EERD_, Feature 5 and Appendix A

## Proposal requirement

> Vendor contacts, quote, contract status and payment due dates. Each expense links to a vendor.

## 1. What the application does

- **Vendor records:** create, view, edit and delete vendors for an event. Each one has a business name, category, contact name, email, phone and notes.
- **Quotes and contracts:** record each vendor's quote amount, contract total, booking status and contract status. New vendors start as Researching with no contract.
- **Status rules:** the server applies the automatic changes and rejects invalid combinations (§2).
- **Payment summary:** each vendor shows its paid total, balance and next payment due date. These are calculated in the database from the vendor's linked expenses and payments, with refunds subtracted. They are read-only on the vendor page, and the due dates themselves are recorded on expenses.
- **Expense link:** each expense links to at most one vendor, which must be in the same event.
- **Protected deletion:** a Booked vendor with a Signed contract can't be deleted, but it can be marked as cancelled instead. A vendor with linked expenses can't be deleted until those expenses are removed.
- **Event scope:** only members of an event (Owner or Co-Planner) can see or change its vendors.
- **Finding vendors:** search, filter by booking status and category, sort by name, next due date or balance, and see summary counts.

## 2. Statuses and rules

| Booking status        | Contract status       |
| --------------------- | --------------------- |
| Researching (default) | Not started (default) |
| Quoted                | Pending               |
| Booked                | Signed                |
| Declined              | Cancelled             |

**Automatic changes**

- Entering a quote on a Researching vendor changes it to Quoted.
- Signing a contract changes the booking status to Booked.
- Moving back to Researching clears the quote, the contract total and the contract status.

**Rules**

- Only Quoted, Booked or Declined vendors can have a quote.
- A contract total needs a contract. While the contract status is Not started, the field is disabled with the hint "Add a contract first".
- Researching vendors can't have a contract.
- Pending and Signed contracts need a Quoted or Booked vendor.
- A Signed contract means the vendor is Booked.
- Moving back to Researching isn't allowed while a contract is Pending or Signed ("Cancel the contract first").
- Moving back to Researching with only a quote, or with a cancelled contract, asks for confirmation before clearing those values.

The Event API enforces these on every create and update. CHECK constraints on the `vendors` table back them up.

## 3. Vendor page (frontend)

### Overview

- Vendors for the selected event, in a responsive card grid.
- Summary metrics calculated from **all** of the event's vendors: booked vendors, quotes received, signed contracts and upcoming payments.
- The summary metrics stay the same when filters are applied.

### Search, filtering and sorting

- Search by business name or contact name.
- Booking-status tabs with live counts: All, Researching, Quoted, Booked, Declined.
- A category dropdown filter, built from the categories the event's vendors use.
- Sort by name, next due date or outstanding balance.
- A "No results" state with a Clear filters action.
- Toolbar layout:
  - Desktop: search, Category and Sort in one row, all 44px high, with custom chevrons.
  - Mobile: search on its own row, the dropdowns below it, and tabs that scroll sideways.

### Vendor cards

- An initials avatar, built from the words that start with a letter ("Fleur & Fern" shows "FF").
- Business name, category and a booking-status badge.
- Contact name, an email link and a phone link. Empty rows are hidden.
- Contract status.
- Quote amount or contract total.
- Outstanding balance, shown as "—" when there's no contract total.
- The next payment date, or a paid status once the contract is fully paid.
- A payment progress bar with "$X paid of $Y" when there's a contract total.
- Cards open the detail drawer by click, touch, Enter or Space.

### Vendor detail drawer

- A right-side panel on desktop, full-screen on mobile.
- Header: avatar, name, category, booking-status badge, and Edit and Close actions.
- Contact section: contact name, email link and phone link.
- Contract section: contract status, quote amount and contract total.
- A read-only payment summary: contract total, paid amount, remaining balance and next due date, with the note "Calculated from this vendor's expenses".
- A View expenses link. Expenses can't be created or edited from the drawer.

### Add and edit forms

- Fields: business name, category, contact name, email, phone, quote amount, contract total, booking status, contract status and notes.
- New vendors default to Researching and Not started.
- Entered values are kept when a save fails.

### Form validation

- Runs when a field loses focus, on submit, and again on the server.
- Business name is required.
- Email must be a valid format when it's provided.
- Quote amount and contract total can't be negative and have at most two decimal places.
- Errors appear inline below each field, from the API's `error.fields`. Errors for the whole form appear in a banner above it.
- The server rejects invalid records with `422 VALIDATION_ERROR`.

### Actions menu (kebab)

- View details
- Edit vendor
- Email vendor (disabled when there's no email address)
- View expenses
- Change booking status
- Change contract status
- Delete vendor

Status options that would break a rule are disabled, with a tooltip explaining why. Status changes are saved with PATCH.

### Keyboard accessibility

- Up and Down arrows move between the enabled menu items, skipping disabled ones.
- Enter selects an item.
- Escape closes the menu and returns focus to the kebab button.

### Protected deletion dialogs

The server decides whether a delete is allowed. The UI sends DELETE and shows the dialog that matches the response:

| Response                                              | Dialog                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `409 SIGNED_CONTRACT` (Booked with a Signed contract) | Explains why. Offers Cancel or **Mark as cancelled**, which sets the contract to Cancelled and the booking to Declined and keeps the vendor and its history |
| `409 HAS_EXPENSES` (any linked expense)               | Explains that the expenses must be removed first. Offers Cancel or View expenses                                                                            |
| Allowed                                               | Before sending, a confirmation names the vendor and offers Cancel or Delete. After `204`, the card is removed and the summary metrics and tab counts update |

When both conflicts apply, the signed-contract conflict wins.

### Read-only computed fields

- Paid total, balance and next due date come from the server.
- The UI shows them on cards and in the drawer, and never edits or recalculates them.

### Page states

- Loading
- Error, with Retry
- No vendors yet, with an Add vendor action
- No access to this event (`403`)
- No results for the current filters, with Clear filters

### Feedback

- Success toasts: Vendor added, Vendor updated, Vendor deleted, Vendor marked as cancelled, Booking status updated, Contract status updated.
- Error toasts for unexpected failures (`500`).
- Forms stay open with their input intact after a failed save.

### Mock service (until the API is deployed)

- `list(eventId)`, `get(id)`, `create(input)`, `update(id, input)` and `remove(id)`, with the same JSON shape and errors as the API.
- Filters by event, keeps data in memory for the session, and generates vendor IDs.
- Create and update accept the editable fields only.
- Throws 422-style validation errors and typed 409-style delete conflicts. A failed request leaves the data unchanged.
- Built to be swapped for the real API without changing the page.

## 4. Backend

- **API Gateway:** the 5 vendor routes behind the Cognito authorizer, with CORS:

  | Method | Route                                  |
  | ------ | -------------------------------------- |
  | GET    | `/events/{eventId}/vendors`            |
  | GET    | `/events/{eventId}/vendors/{vendorId}` |
  | POST   | `/events/{eventId}/vendors`            |
  | PATCH  | `/events/{eventId}/vendors/{vendorId}` |
  | DELETE | `/events/{eventId}/vendors/{vendorId}` |

- **Event API Lambda:** the vendor routes are part of the shared Event API Lambda (`backend/vendor-service/`). They provide:
  - field validation
  - the status rules
  - a membership check on every route
  - 409 conflicts for protected deletes
  - mapping of database errors: 3819 → 422, 1451 → 409
- **Errors:**

  | Status | Code                              |
  | ------ | --------------------------------- |
  | 400    | `BAD_REQUEST`                     |
  | 401    | From API Gateway                  |
  | 403    | `FORBIDDEN`                       |
  | 404    | `NOT_FOUND`                       |
  | 409    | `SIGNED_CONTRACT`, `HAS_EXPENSES` |
  | 422    | `VALIDATION_ERROR`                |
  | 500    | `INTERNAL_ERROR`                  |

  The [API contract](../api/vendors.md) has the details.

- **RDS:**
  - The `vendors` table, with DECIMAL(12,2) money, ENUM statuses, `category`, `contract_total` and `booking_status`, and CHECK constraints for the status rules.
  - The `vendor_payment_totals` view: paid total (with refunds subtracted) and next due date. The vendor API and the payment alerts both use it.
  - `expenses.(vendor_id, event_id)` is a foreign key to `vendors` with `ON DELETE RESTRICT`.
  - No `payment_due_date` on vendors. Due dates come from expenses.
- **Expense link:** the expenses repository checks the vendor is in the same event inside its own transaction, and returns 422 (expenses API).
