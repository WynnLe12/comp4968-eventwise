# Event list and switcher testing

Start the existing Docker MySQL database and Node backend with their existing environment configuration. From `frontend/organizer`, run `npm run dev`; Vite forwards `/api` to the backend on port 3000. Sign in with a Cognito user that has memberships in the local database.

1. In browser Network tools, verify `GET /api/events` uses the Cognito **access** token in its Bearer header. Do not copy tokens into source files or logs.
2. Verify the sidebar selector contains only that user's events. It initially selects the first event in the backend's date-sorted response.
3. Switch events in the sidebar and on the Events page. Confirm the selection, dashboard banner/date/venue/budget, and profile membership role update together. The signed-in profile name must remain the same.
4. Verify both OWNER and CO_PLANNER labels using users/memberships with those roles. Event IDs and decimal budgets remain strings without precision loss. No currency is assumed by the API.
5. Sign in with a user without events: expect an empty selector and a No events state, with no sample event cards or dashboard data.
6. Stop the backend: expect an error state and Try again. Restart it and retry; the API data should return.
7. Expire/remove the session or simulate a 401 response: event state must clear and the app must require sign-in again. Cognito credentials are cleared before returning to login.
8. Sign out during a slow request, then sign in as another account. Old results and selection must not reappear. Returning focus to the window refreshes events; a selection is retained only for the same account and only if membership still exists.
9. Navigate to budget, guests, vendors, and other unconnected event sections. They show an unavailable state rather than old sample data. Routes and navigation remain available; those feature components are unchanged. Event editing is outside this integration.

The dashboard retains its banner, summary card grid, and section cards. Only values supplied by the event-list API are shown; guest counts, spending, planning progress, vendors, tasks, and milestones are not inferred or filled with mock data. Selection is kept in memory only and resets when signing out or changing accounts.

Run local checks from `frontend/organizer`:

```sh
npm run typecheck
npm run build
npm test
```

Tests use mocked authentication/fetch and controlled hook lifecycle checks, plus server-rendered switcher and state views. Live Cognito, backend permissions, and browser interaction should be checked with the steps above.


## Create Event

1. Start MySQL, the backend, and Vite using their existing configuration, then sign in. Choose **Create event** on the dashboard, Events page, or no-events empty state.
2. Verify the existing modal opens with blank values. Name is required (maximum 150 Unicode characters). Date and venue are optional (venue maximum 255 characters); blank date/venue are sent as null. A blank budget is omitted so MySQL/backend applies its declared zero default. A supplied budget must be nonnegative, at most 9999999999.99, with no more than two fractional digits.
3. Leave the template option unchecked to send `template_id: null`. To use a template, check the option and enter an existing `event_templates.template_id`. The backend currently provides no template catalog endpoint, so the frontend does not guess template IDs or promise to populate tasks/budgets. A nonexistent template shows an actionable error.
4. Submit using **Create event** or Enter. In Network tools confirm one `POST /api/events` with the current Cognito access token and only the supported event fields. Double-click while the request is slow: there must be only one POST; the form and cancel/close actions stay locked until it finishes.
5. Expect POST 201, followed by GET /api/events. The modal closes and the new event is selected in the switcher and dashboard, including when this was the user's first event. Role comes from the refreshed membership list.
6. Test an empty name, overlong values, invalid dates, negative/over-precision budgets, and an unavailable template. Validation/API errors must stay in the form without exposing SQL or credentials.
7. Simulate a successful POST followed by a failed GET. The form must say the event was created and offer **Retry loading event**. Restore GET and retry: this must issue GET only, never another POST.
8. Test a 401/expired session and signing out or switching accounts while a request is pending. Old responses must not select an event in the next account. A network failure can make the POST result uncertain; check the event list before submitting again.

Local automated tests cover API request/response shapes, validation, safe errors, duplicate submission guards, refresh-only retry, empty-account selection, logout races, and the modal's submit/loading markup. Live authenticated creation and browser interactions still need the checks above.
