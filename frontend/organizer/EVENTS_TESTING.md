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
9. Navigate to budget, guests, vendors, and other unconnected event sections. They show an unavailable state rather than old sample data. Routes and navigation remain available; those feature components are unchanged. Editing is available to event owners through the dashboard.

The dashboard retains its banner, summary card grid, and section cards. Only values supplied by the event APIs are shown; guest counts, spending, planning progress, vendors, tasks, and milestones are not inferred or filled with mock data. Selection is kept in memory only and resets when signing out or changing accounts.

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


## Selected event details

1. Start the existing backend and Vite, sign in, and select an event. Network tools should show `GET /api/events/{eventId}` with the current Cognito access token. The response is one event object, not an envelope or list.
2. Confirm the dashboard's name, calendar date, venue, total budget, template ID (if set), and role match that detail response. The endpoint supplies no template label/type; the UI must not guess one. No template is displayed when `template_id` is null. Unconnected guest, spending, vendor, task, and expense information remains unavailable.
3. Switch quickly between two events with network throttling enabled. The old detail request is aborted; its late success or failure must never replace the selected event. Loading hides previous dashboard details and role.
4. Test both OWNER and CO_PLANNER membership: either may view details; the profile and sidebar role must match the detail response.
5. Simulate or arrange a detail 403 (membership revoked) or 404 (event removed after listing). Expect the corresponding unavailable/not-found state with no dashboard data, plus Refresh events. The sidebar and Events page remain usable to select another event. A 401 uses the existing sign-out/sign-in flow.
6. Simulate a detail 500, malformed JSON, or network failure. Expect a generic error and Try again, without internal database details or fallback event content. Restore the service and retry to load the real details.
7. Sign out or switch accounts during a throttled request. Details must clear; the old response cannot populate the new account, including if the same event is shared by both users.
8. Create an event through the existing form. After the list refresh selects it, verify its detail request completes before dashboard data appears.

Automated tests cover request/response shape, exact string IDs/budgets, role and template display, 401/403/404, stale requests, account changes, loading/error UI, and the existing list/create behavior. These tests use mocked API/auth responses; the live flow still requires the checks above.


## Edit Event (owners only)

1. Start the existing local services, sign in as an OWNER, select an event, and wait for its detail request to finish. Choose **Edit event** in the dashboard header. The modal should contain the real name, template ID, calendar date, venue, and total budget from GET by ID, with no mock defaults.
2. Change only the name and save. Inspect Network: PATCH `/api/events/{eventId}` must contain only `name`, authenticated by the Cognito access token. Neither user identity nor membership/ownership/timestamps are sent. Expect HTTP 200, then refreshed GET list/details. The same event remains selected and its new name appears in the switcher.
3. Reopen without changing anything: Save is disabled. Changing whitespace or decimal formatting alone must not send an update. Change values and choose Cancel: no PATCH is sent, and reopening restores server values.
4. Clear template, date, or venue: each changed blank optional field sends null. Name and budget cannot be cleared. Validate overlong names/venues, nonexistent template IDs, invalid dates, negative budgets, and budgets with more than two fractional digits. Errors remain in the modal without exposing server internals.
5. With a CO_PLANNER account, verify no Edit action appears. The backend remains the authority: if ownership changes after the modal opens, a 403 blocks additional saves and asks the user to close the editor and refresh. Test 404 similarly for an event removed after loading.
6. Under throttling, double-click Save and try closing during the request. Only one PATCH is sent, controls remain disabled, and cancellation cannot interrupt the pending save. If PATCH succeeds but refreshing fails, any Retry loading action must reload data rather than repeat PATCH.
7. Test a server/network error and retry, plus a 401 to confirm the existing authentication flow runs. Network errors can make a save result uncertain; refresh before repeating a write.
8. Switch events or accounts while a throttled save is in flight. The old editor closes; late results must not select the previous event or overwrite the new selection. Closing/unmounting aborts the browser request, though a write already received by the backend may still complete.

Focused tests cover changed-field construction, schema validation, authenticated PATCH payloads, safe status messages, expected-account guards, owner-only actions, actual prefilled values, cancellation, duplicate guards, refresh-only retry, and stale responses. Live browser/Cognito checks remain manual. No event deletion is implemented.
