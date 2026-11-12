# Event templates MVP

Five shared templates provide provisional budget defaults. Checklist generation,
custom templates, reapplication, event creation and category copying are out of scope.

## Local setup

The existing MySQL container must be running. From `backend/`, load only this seed:

```sh
npm run db:seed -- 03_template_defaults_seed.sql
```

The seed is transactional and rerunnable: it upserts templates by key and categories
by template/name, preserving IDs. It does not delete unrelated categories or event data.
Defaults are provisional and require team confirmation. On the shipped fixture data,
each template totals 100%; pre-existing extra categories require review before seeding.

Export DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME using the values in
`.env.example`. The pool defaults to 127.0.0.1:3307, user/database eventwise;
DB_PASSWORD must be supplied. `.env` is not loaded automatically. Then run `npm run dev`.

## API

`GET /event-templates` returns status 200:

```json
{"templates":[{"templateId":"1","templateKey":"wedding","name":"Wedding","description":"Provisional budget defaults; subject to team confirmation."}]}
```

The actual list contains all database templates, ordered by ID.

`GET /event-templates/1` returns status 200:

```json
{"template":{"templateId":"1","templateKey":"wedding","name":"Wedding","description":"Provisional budget defaults; subject to team confirmation.","categories":[{"templateCategoryId":"1","name":"Venue & Catering","defaultPercentage":"42.00","sortOrder":1}]}}
```

Examples abbreviate arrays; IDs depend on the database. Categories are ordered by
sortOrder then ID. IDs and DECIMAL percentages are JSON strings; sortOrder is a number.
Malformed/nonpositive/out-of-range unsigned BIGINT IDs return 400. Missing templates
return 404. Database failures return a generic 500; internal details are logged.
Errors use `{"error":"message"}`. Unsupported routes/methods retain the scaffold's 404.

## Verification

`npm test` runs scaffold and ID-validation tests. Run `TEST_MYSQL=1 npm test` with
DB_* exported to additionally run read-only MySQL integration tests for both endpoints,
five types, actual persisted category values/order, percentage totals and missing IDs.
These tests do not seed or reset the database.

## Integration boundaries

Wynn owns authentication/authorization; these routes currently have no auth middleware,
consistent with the existing scaffold. Add the agreed auth integration before deployment.
Feature 1 will consume the selected template ID. Coordinate allocation calculations and
transactional category initialization with Minh; neither is implemented here.
The Templates Tab loads the list and selected template details from these APIs.
Both requests support loading, error/retry and empty states; requests are cancelled
when their component unmounts. The separate Create Event dialog supports allocation
preview; event persistence is not implemented.

Start the backend on port 3000 with DB_* exported, and run `npm run dev` in
`frontend/organizer`. The Vite development server forwards `/api/*` to
`http://127.0.0.1:3000/*`; no backend CORS change is required. This proxy is dev-only.
For hosting, use a same-origin `/api` reverse proxy or build with public
`VITE_API_BASE_URL` pointing to an API with appropriate CORS. Never put secrets there.

After simulated sign-in, open More → Templates (`/app/templates`). Verify all five
seeded types and use “View budget defaults” to inspect persisted categories/percentages.
If the backend is unavailable, expect an error with Retry, not mock fallback data.
A list response with `templates: []` shows an empty state; details with
`categories: []` show “No budget defaults yet”. This integration does not apply seeds.
The Budget reset dialog remains a separate prototype flow. See the Create Event
frontend handoff below for the template selector and allocation preview.

## Create Event frontend handoff

`CreateEventModal` is now used for the Event dialog. It owns controlled fields
`name`, `templateId`, `eventDate`, `venue`, `totalBudget` (`CreateEventDraft`).
The required event type select loads the template list; selecting it fetches defaults.
Budget preview is read-only and responds to type and total changes. Failed requests
can be retried and stale requests are cancelled. Missing/invalid defaults do not produce
an allocation. Amounts use integer cents with a deterministic largest-remainder rule,
ties resolved by template order. This provisional rule must be agreed with Minh before
backend integration. Zero is valid; money is limited to DECIMAL(12,2).

Wynn should wire the form submission to POST /events, validating fields and taking
ownership identity from authenticated context. No POST request currently occurs and
the Create event button is deliberately disabled. On integration, enable submission
only with valid fields/defaults, handle pending/error/success, and return the created
event ID to selected-event state. Empty dates/venues should be normalized according
to the agreed Event API contract. The backend must reload defaults and calculate
amounts itself, then insert event/member/budget categories in one transaction using
the agreed Budget initializer. Do not trust preview amounts as persisted input.

Check the pure allocation utility with:
`node --test tests/budgetPreview.test.mjs` from `frontend/organizer`.
For manual testing open My events → Create event, select each type and enter a budget;
verify amounts sum to the input, including 0 and 0.01. Rapidly switch types, retry failed
requests, and cancel/reopen the dialog to verify a clean draft. This does not save data.
