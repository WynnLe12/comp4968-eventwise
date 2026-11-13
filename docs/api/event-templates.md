# Event templates MVP

Five shared templates provide provisional budget defaults. Checklist generation,
custom templates, reapplication, and category copying are out of scope for the template module. Authenticated event creation is integrated through the existing Event API.

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
DB_PASSWORD must be supplied. The merged `npm run dev` loads backend `.env` (including Cognito pool/client configuration).

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

The shared template catalog retains its documented public, read-only endpoints.
Event creation/list/detail/update routes retain Cognito access-token verification,
verified-sub identity, membership checks, and OWNER-only editing. Do not treat the
frontend preview or selected template as authorization. Authentication policy for
shared catalog reads must be agreed before deployment.

Both modules use the existing `shared/db/db.ts` pool; `shared/db/pool.ts` is a
compatibility export, not another connection pool. Template IDs are strings from
`event_templates.template_id`, and default percentages are DECIMAL strings from
`template_budget_categories.default_percentage`. No schema change is required.

The Templates tab and Create Event selector load the real catalog and selected
defaults with loading, retry, empty and stale-request handling. The working Create
Event submission/selection flow is preserved. The allocation is a provisional,
read-only preview: this integration does not copy categories into events or add
tasks/timelines. Persisted category initialization remains a separate Budget
initializer decision and must recompute defaults server-side when implemented.

Start the backend on port 3000 with DB_* exported, and run `npm run dev` in
`frontend/organizer`. The Vite development server forwards `/api/*` to
`http://127.0.0.1:3000/*`; no backend CORS change is required. This proxy is dev-only.
For hosting, use a same-origin `/api` reverse proxy or build with public
`VITE_API_BASE_URL` pointing to an API with appropriate CORS. Never put secrets there.

After Cognito sign-in, open More → Templates (`/app/templates`). Verify all five
seeded types and use “View budget defaults” to inspect persisted categories/percentages.
If the backend is unavailable, expect an error with Retry, not mock fallback data.
A list response with `templates: []` shows an empty state; details with
`categories: []` show “No budget defaults yet”. This integration does not apply seeds.
The Budget reset dialog remains a separate prototype flow. See the Create Event
frontend handoff below for the template selector and allocation preview.

## Combined Create Event integration

The single implementation is `features/events/components/CreateEventModal.tsx`;
`features/events/CreateEventModal.tsx` only re-exports it for compatibility. The
form retains the teammate's controlled `CreateEventDraft` and read-only preview.
Submission uses the existing authenticated `useCreateEvent`/`eventApi` path:

| Frontend field | POST /events field |
| --- | --- |
| name | name |
| templateId | template_id |
| eventDate | event_date (blank becomes null) |
| venue | venue (blank becomes null) |
| totalBudget | total_budget (decimal string) |

No identity, role, preview categories, percentages, or calculated amounts are sent.
The backend validates any supplied ID against `event_templates` inside the same
transaction that creates the event and OWNER membership. Existing optional/null
template support in the Event API remains unchanged; this template-focused form
requires a selected type with valid defaults and a valid budget before submission.

On POST success the event list refreshes and selects the returned event ID; the
detail view loads normally. Duplicate clicks, expired sessions, account changes,
and refresh-only retries after successful creation retain their existing guards.
Name/date/venue/budget validation and backend error messages are preserved.

Allocation uses integer cents and largest remainders; ties follow template order.
The UI rejects missing/invalid defaults instead of inventing allocations. Defaults
are provisional and require team confirmation; the displayed amounts are not
saved as event budget categories.

## Merge validation and manual checks

Run frontend typecheck/build/`npm test` (includes `scripts/*.test.mjs` and the
teammate's `tests/budgetPreview.test.mjs`). Run backend typecheck/build/`npm test`.
With local DB_* and Cognito configuration in backend `.env`, run MySQL checks:

```powershell
$env:EVENTWISE_MYSQL_TEST = '1'
$env:TEST_MYSQL = '1'
node --env-file=.env --test dist/tests/createEvent.mysql.test.js dist/tests/listEvents.mysql.test.js dist/tests/getEvent.mysql.test.js dist/tests/updateEvent.mysql.test.js dist/tests/templates.test.js
```

1. Load only `03_template_defaults_seed.sql` if defaults have not yet been installed.
   Existing template IDs and event data are preserved; never reset the database for
   this merge. Extra custom categories can make totals exceed 100% and require review.
2. Sign in, open Templates (also available without any events), and inspect database
   names, categories, and ordering. Test unavailable backend, retry, and empty states.
3. Open Create Event, choose each type, and verify preview totals for 0, 0.01, and a
   regular budget. Switch rapidly and verify stale/default-error requests cannot submit.
4. Submit a named event and inspect Network: one authenticated POST contains the chosen
   `template_id` and exact `total_budget`. No preview amounts or user identity are sent.
5. Confirm the new event is selected and GET list/details show the correct template ID,
   budget and OWNER role. Edit as owner; check that CO_PLANNER cannot edit and unrelated
   users cannot access the event. Existing event routes remain `/events/:eventId`.
6. Test cancellation, double-click prevention, logout during a request, and list-refresh
   failure after successful creation (retry GET only, not a second POST).

No Terraform, deployments, schema changes, or merge commit are part of this work.
