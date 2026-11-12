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
9. Navigate to budget, guests, vendors, and other unconnected event sections. They show an unavailable state rather than old sample data. Routes and navigation remain available; those feature components are unchanged. Creation/editing is outside this integration.

The dashboard retains its banner, summary card grid, and section cards. Only values supplied by the event-list API are shown; guest counts, spending, planning progress, vendors, tasks, and milestones are not inferred or filled with mock data. Selection is kept in memory only and resets when signing out or changing accounts.

Run local checks from `frontend/organizer`:

```sh
npm run typecheck
npm run build
npm test
```

Tests use mocked authentication/fetch and controlled hook lifecycle checks, plus server-rendered switcher and state views. Live Cognito, backend permissions, and browser interaction should be checked with the steps above.
