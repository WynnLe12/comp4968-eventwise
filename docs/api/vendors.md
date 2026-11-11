# Vendor API contract (Feature 5)

The backend and frontend both build against this document. If either side needs a change after it's approved, message the other person first, then update this file in a pull request.

The vendor routes live in the shared Event API Lambda, behind API Gateway with the Cognito authorizer. The data lives in the `vendors` table in RDS MySQL. `eventwise_schema.sql` and its EERD are the source of truth.

## 1. Routes

Every route needs a Cognito **ID token** in the `Authorization` header (send the token itself, with no `Bearer` prefix). Every route also checks that the signed-in user belongs to `{eventId}` (`event_members`, either role).

| Method | Path                                   | Request body                        | Success                                                 |
| ------ | -------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| GET    | `/events/{eventId}/vendors`            | none                                | `200`, array of [Vendor](#2-vendor-json) sorted by name |
| GET    | `/events/{eventId}/vendors/{vendorId}` | none                                | `200`, one Vendor                                       |
| POST   | `/events/{eventId}/vendors`            | [editable fields](#editable-fields) | `201`, the created Vendor                               |
| PATCH  | `/events/{eventId}/vendors/{vendorId}` | only the fields that change         | `200`, the updated Vendor                               |
| DELETE | `/events/{eventId}/vendors/{vendorId}` | none                                | `204`, no body                                          |

- All status changes use **PATCH**: booking status, contract status, "Mark as cancelled" and moving back to Researching. There is no separate status route.
- POST and PATCH return the vendor as read back from the database, so the response always has up-to-date `paidTotal`, `balance` and `nextDueDate`.
- The list has no query parameters. Search, the booking-status tabs, the category filter, sorting and the summary metrics are all done in the browser from the full list. That keeps the summary the same while filters are applied.
- Request and response bodies are JSON (`Content-Type: application/json`).

---

## 2. Vendor JSON

Every route that returns a vendor returns this shape:

```json
{
  "id": 17,
  "eventId": 42,
  "name": "The Willow House",
  "category": "Venue & Catering",
  "contactName": "Grace Hill",
  "email": "events@thewillowhouse.com",
  "phone": "(555) 014-2280",
  "quoteAmount": "12800.00",
  "contractTotal": "12800.00",
  "bookingStatus": "BOOKED",
  "contractStatus": "SIGNED",
  "notes": "Final headcount due 30 days before the event.",
  "paidTotal": "5000.00",
  "balance": "7800.00",
  "nextDueDate": "2027-06-15",
  "createdAt": "2026-11-12T17:30:02Z",
  "updatedAt": "2026-11-12T18:04:11Z"
}
```

### Field reference

| Field            | Type           | Editable          | Notes                                                                       |
| ---------------- | -------------- | ----------------- | --------------------------------------------------------------------------- |
| `id`             | number         | no                | `vendors.vendor_id`                                                         |
| `eventId`        | number         | no                | Comes from the URL; ignored in a request body                               |
| `name`           | string         | **yes, required** | Business name, 1–150 characters                                             |
| `category`       | string \| null | yes               | Up to 100 characters, free text (e.g. "Photography")                        |
| `contactName`    | string \| null | yes               | Up to 150 characters                                                        |
| `email`          | string \| null | yes               | Valid email format, up to 254 characters                                    |
| `phone`          | string \| null | yes               | Up to 40 characters, stored as typed                                        |
| `quoteAmount`    | money \| null  | yes               | See [status rules](#4-status-and-amount-rules)                              |
| `contractTotal`  | money \| null  | yes               | Needs a contract (contract status isn't `NOT_STARTED`)                      |
| `bookingStatus`  | enum           | yes               | `RESEARCHING` · `QUOTED` · `BOOKED` · `DECLINED`                            |
| `contractStatus` | enum           | yes               | `NOT_STARTED` · `PENDING` · `SIGNED` · `CANCELLED`                          |
| `notes`          | string \| null | yes               | Up to 2000 characters                                                       |
| `paidTotal`      | money          | **no**            | Calculated by the server, never `null` (`"0.00"` with no payments)          |
| `balance`        | money \| null  | **no**            | `contractTotal − paidTotal`; `null` when there's no contract total          |
| `nextDueDate`    | date \| null   | **no**            | Earliest due date of a linked expense that isn't fully paid; `null` if none |
| `createdAt`      | timestamp      | no                |                                                                             |
| `updatedAt`      | timestamp      | no                | Changes on every update                                                     |

### Formats

- **Names** are camelCase in JSON. The database uses snake_case, and the backend converts between them.
- **IDs** are numbers (`BIGINT UNSIGNED`). Path parameters arrive as strings, and the backend handles that.
- **Money** is a string with exactly 2 decimals in responses, such as `"12800.00"`. MySQL `DECIMAL(12,2)` keeps it exact. Convert to a number only for display. Requests can send a string (`"500"`, `"500.5"`, `"500.50"`) or a number (`500`). Strings are recommended because they avoid floating-point surprises.
- **Dates** are `YYYY-MM-DD`. **Timestamps** are ISO 8601 in UTC.
- **Empty values**: an empty or whitespace-only string is saved as `null`. Text fields are trimmed.

### UI labels for statuses

These match the labels in the features document.

| API value     | Label       |
| ------------- | ----------- |
| `RESEARCHING` | Researching |
| `QUOTED`      | Quoted      |
| `BOOKED`      | Booked      |
| `DECLINED`    | Declined    |
| `NOT_STARTED` | Not started |
| `PENDING`     | Pending     |
| `SIGNED`      | Signed      |
| `CANCELLED`   | Cancelled   |

### Editable fields

`name`, `category`, `contactName`, `email`, `phone`, `quoteAmount`, `contractTotal`, `bookingStatus`, `contractStatus`, `notes`.

Any other key in a POST or PATCH body (`id`, `eventId`, `paidTotal`, `balance`, `nextDueDate`, timestamps, unknown keys) is **ignored**, not rejected. To clear a field, send `null` or `""`.

---

## 3. How the read-only totals are calculated

These are calculated in the database from the vendor's linked expenses (`expenses.vendor_id`) and their payments (`expense_payments`). The UI shows them and never edits or recalculates them.

`paidTotal` and `nextDueDate` come only from the `vendor_payment_totals` view in the schema. The payment alerts (Feature 9) use the same view, so the vendor page and the alert emails always agree.

- **`paidTotal`** = sum of `DEPOSIT` and `PAYMENT` amounts minus sum of `REFUND` amounts, across all of the vendor's expenses. `"0.00"` for a vendor with no expenses.
- **`balance`** = `contractTotal − paidTotal`, or `null` when `contractTotal` is `null`. It can go negative if the vendor was overpaid. Calculated in the vendor query from the view's `paid_total`.
- **`nextDueDate`** = the earliest `due_date` among the vendor's expenses whose net payments are still below their `committed_amount`. Expenses with no due date are skipped. `null` when nothing is due.

Due dates are recorded on expenses (Feature 4), not on the vendor.

---

## 4. Status and amount rules

The server applies these on POST and PATCH, using the vendor as it will be saved (current values plus the changes). A new vendor starts as `RESEARCHING` + `NOT_STARTED`.

**Automatic changes** (applied before checking):

1. Moving to `RESEARCHING` from any other booking status clears `quoteAmount` and `contractTotal`, and sets `contractStatus` to `NOT_STARTED`. This is refused while the contract is `PENDING` or `SIGNED`.
2. Setting a `quoteAmount` on a `RESEARCHING` vendor (without also changing the booking status) moves it to `QUOTED`.
3. Setting `contractStatus` to `SIGNED` moves the booking status to `BOOKED`.

**Combinations that are refused with 422** (field and message):

| Rule                                                        | Field            | Message                                                              |
| ----------------------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| Back to Researching while the contract is pending or signed | `bookingStatus`  | Cancel the contract first                                            |
| Quote on a researching vendor                               | `quoteAmount`    | Researching vendors can't have a quote yet                           |
| Contract total with no contract                             | `contractTotal`  | Add a contract first                                                 |
| Any contract on a researching vendor                        | `contractStatus` | Researching vendors can't have a contract                            |
| Pending or signed contract on a declined vendor             | `contractStatus` | Only quoted or booked vendors can have an active contract            |
| Signed contract on a vendor that isn't booked               | `bookingStatus`  | A vendor with a signed contract is booked. Cancel the contract first |

**Field validation** (also 422):

| Field                          | Rule                                   | Message                                             |
| ------------------------------ | -------------------------------------- | --------------------------------------------------- |
| `name`                         | Required, not blank                    | Business name is required                           |
| text fields                    | Within the max length above            | Keep this under N characters                        |
| `email`                        | Valid format when given                | Enter a valid email address                         |
| `quoteAmount`, `contractTotal` | 0 to 9999999999.99, at most 2 decimals | Enter an amount of 0 or more, with up to 2 decimals |
| `bookingStatus`                | One of the 4 values                    | Choose a valid booking status                       |
| `contractStatus`               | One of the 4 values                    | Choose a valid contract status                      |

The UI runs the same checks for instant feedback (on blur and on submit), but the server is the final check.

The `vendors` table also has CHECK constraints for the status rules, as a safety net behind the API. If one of them ever rejects a row (MySQL error 3819), the API still returns `422 VALIDATION_FAILED` with the matching field, never a 500.

**Moving back to Researching:** the UI confirms first when the vendor has a quote or a cancelled contract, because the server will clear those values.

## 5. Deleting a vendor

DELETE checks these in order. The first one that applies wins:

1. **Booked with a signed contract** → `409 SIGNED_CONTRACT`. Nothing is deleted. The UI offers "Mark as cancelled" instead (see below).
2. **Has any linked expense** (paid or not) → `409 HAS_EXPENSES`. Nothing is deleted. The UI offers "View expenses". The expenses must be removed or moved to another vendor first.
3. Otherwise the vendor is deleted → `204`.

**Mark as cancelled** keeps the vendor and its history:

```http
PATCH /events/42/vendors/17
{ "contractStatus": "CANCELLED", "bookingStatus": "DECLINED" }
```

## 6. Errors

Every error from the Lambda uses this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some fields need fixing.",
    "fields": { "email": "Enter a valid email address" }
  }
}
```

`fields` appears only on `422`. Its keys are the JSON field names, so each message can go straight under its input.

| Status | `code`               | When                                                                   | Frontend shows                                     |
| ------ | -------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| 400    | `INVALID_JSON`       | The request body isn't valid JSON                                      | Error toast                                        |
| 401    | — (from API Gateway) | No token, or an expired or invalid token                               | Login page                                         |
| 403    | `NOT_EVENT_MEMBER`   | Signed in, but not a member of this event (or the event doesn't exist) | No-access state                                    |
| 404    | `VENDOR_NOT_FOUND`   | The vendor doesn't exist, or it belongs to another event               | Toast, then reload the list                        |
| 409    | `SIGNED_CONTRACT`    | DELETE on a booked vendor with a signed contract                       | Mark-as-cancelled modal                            |
| 409    | `HAS_EXPENSES`       | DELETE on a vendor with linked expenses                                | View-expenses modal                                |
| 422    | `VALIDATION_FAILED`  | A field is invalid, or the status combination isn't allowed            | Inline errors from `fields`; banner with `message` |
| 500    | `INTERNAL_ERROR`     | Anything unexpected                                                    | Error toast; form stays open with input kept       |

Notes:

- The **401** comes from the API Gateway Cognito authorizer, before the Lambda runs. Its body is API Gateway's own (`{"message":"Unauthorized"}`), not the shape above, so check the status code, not `error.code`.
- A vendor from another event returns **404**, not 403, so the API never reveals that it exists.
- A failed request changes nothing.

## 7. Examples

### Create with only a name

```http
POST /events/42/vendors
{ "name": "Rosewood Rentals" }
```

`201`:

```json
{
  "id": 23,
  "eventId": 42,
  "name": "Rosewood Rentals",
  "category": null,
  "contactName": null,
  "email": null,
  "phone": null,
  "quoteAmount": null,
  "contractTotal": null,
  "bookingStatus": "RESEARCHING",
  "contractStatus": "NOT_STARTED",
  "notes": null,
  "paidTotal": "0.00",
  "balance": null,
  "nextDueDate": null,
  "createdAt": "2026-11-13T19:02:44Z",
  "updatedAt": "2026-11-13T19:02:44Z"
}
```

### Add a quote (moves to Quoted)

```http
PATCH /events/42/vendors/23
{ "quoteAmount": "850.00" }
```

`200`, with `"quoteAmount": "850.00"` and `"bookingStatus": "QUOTED"`.

### Sign the contract (moves to Booked)

```http
PATCH /events/42/vendors/23
{ "contractStatus": "SIGNED", "contractTotal": "850.00" }
```

`200`, with `"contractStatus": "SIGNED"`, `"bookingStatus": "BOOKED"` and `"balance": "850.00"`.

### Invalid fields

```http
POST /events/42/vendors
{ "name": "", "email": "not-an-email", "quoteAmount": "-5" }
```

`422`:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some fields need fixing.",
    "fields": {
      "name": "Business name is required",
      "email": "Enter a valid email address",
      "quoteAmount": "Enter an amount of 0 or more, with up to 2 decimals"
    }
  }
}
```

### Contract total with no contract

```http
PATCH /events/42/vendors/23     (vendor is QUOTED + NOT_STARTED)
{ "contractTotal": "900.00" }
```

`422` with `"fields": { "contractTotal": "Add a contract first" }`.

### Delete a signed vendor

```http
DELETE /events/42/vendors/17
```

`409`:

```json
{
  "error": {
    "code": "SIGNED_CONTRACT",
    "message": "This vendor has a signed contract. Mark it as cancelled instead."
  }
}
```

### Delete a vendor with expenses

`409`:

```json
{
  "error": {
    "code": "HAS_EXPENSES",
    "message": "Remove this vendor's expenses before deleting it."
  }
}
```

---

## 8. Linking expenses to vendors (Feature 4 dependency)

An expense can link to at most one vendor (`expenses.vendor_id`, nullable), and that vendor must belong to the same event.

- The expenses API (Shinyoung) calls the vendor module's `assertVendorInEvent(eventId, vendorId)` before it creates or updates an expense.
- A vendor from another event, or one that doesn't exist, returns `422 VALIDATION_FAILED` from the **expense** route with `"fields": { "vendorId": "Choose a vendor from this event" }`.
- The database backs this up: `expenses` has a composite foreign key `(vendor_id, event_id) → vendors(vendor_id, event_id)` with `ON DELETE RESTRICT`. If that key rejects an expense (MySQL error 1452), the expense route returns the same 422.
- The same foreign key stops a vendor with expenses from being deleted. If an expense is added between the vendor API's check and the delete, MySQL error 1451 is returned as `409 HAS_EXPENSES`.
- The expense form's vendor dropdown should be filled from `GET /events/{eventId}/vendors`.

## 9. Schema changes this contract depends on

These vendor changes are already in `eventwise_schema.sql` and the EERD (marked in purple). They're listed as an open design decision in the features document, so the team still needs to approve them before the schema runs on RDS:

| Change                                                                                               | Why                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Add `category VARCHAR(100) NULL`                                                                     | Category badge on cards and the category filter                                 |
| Add `contract_total DECIMAL(12,2) NULL` (+ `CHECK >= 0`)                                             | Balance is contract total minus paid; a quote isn't a commitment                |
| Add `booking_status ENUM('RESEARCHING','QUOTED','BOOKED','DECLINED') NOT NULL DEFAULT 'RESEARCHING'` | Status rules, booking tabs and the protected-delete rule depend on it           |
| Add `updated_at TIMESTAMP ... ON UPDATE CURRENT_TIMESTAMP`                                           | `updatedAt` in the JSON; matches `events` and `expenses`                        |
| Add status CHECK constraints                                                                         | The database rejects invalid status combinations even if a bug lets one through |
| Drop `payment_due_date`                                                                              | Due dates live on expenses; a second copy on the vendor can disagree with them  |
| Add the `vendor_payment_totals` view                                                                 | One definition of paid total and next due date for vendors and alerts           |

## 10. Decisions

| Decision                                                                                | Why                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| camelCase JSON field names                                                              | Matches TypeScript conventions, so the frontend's `Vendor` type uses the JSON directly      |
| IDs are numbers                                                                         | `BIGINT UNSIGNED` comes back from mysql2 as a JavaScript number, exact far beyond our data  |
| Money is a 2-decimal string in responses; requests accept a string or a number          | Keeps `DECIMAL` values exact. Convert to a number only for display                          |
| Status values are UPPERCASE, matching the database ENUMs, with the UI labels in §2      | No translation layer between the database and the API, so no mapping bugs                   |
| `quoteAmount`                                                                           | Matches the `quote_amount` column                                                           |
| Search, filters, sorting and summary metrics are done in the browser from the full list | An event has tens of vendors, not thousands, and the summary must ignore filters anyway     |
| Unknown and read-only fields in a request body are ignored, not rejected                | The frontend can send back a whole vendor object without stripping fields first             |
| `category` is free text, not a fixed list                                               | The category filter is built from the categories the event's vendors actually use           |
| Error shape and codes as in §6, including the 401 body coming from API Gateway          | One error format for every route; the frontend switches on the status code and `error.code` |
