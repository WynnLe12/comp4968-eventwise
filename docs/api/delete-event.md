# Delete Event

`DELETE /events/:eventId` (organizer: `DELETE /api/events/:eventId`, through the Vite proxy).

Send the existing Cognito **access token** in `Authorization: Bearer <token>`. No request body is needed. Identity is taken only from the verified token. IDs are validated as positive MySQL BIGINT UNSIGNED strings without converting to JavaScript numbers.

Only the event's OWNER can delete it. Authorization and dependent-record checks run while the event/membership and relevant child rows are locked in one MySQL transaction.

Responses follow existing delete/error conventions:

| Status | Meaning |
| --- | --- |
| 204 | Deleted successfully; no response body |
| 400 | Invalid event ID |
| 401 | Missing, invalid, or expired access token |
| 403 | Authenticated user is not the OWNER, including CO_PLANNER |
| 404 | Event does not exist |
| 409 | Recorded expense payments or cross-event references prevent deletion |
| 500 | Unexpected failure; `{ "error": "Unable to delete event" }` |

All error bodies retain the existing `{ "error": "..." }` shape. Internal database details are not returned.

## Related data policy

The schema has no soft-delete field. Deletion is permanent; no schema or FK changes are introduced.

- Preserve Expense's payment-history protection: **any** expense payment/refund record blocks deletion, even if its net amount is zero. The endpoint does not provide an override or delete payment history.
- Reject cross-event task assignments or draft-document links that would otherwise be set to null in another event by FK actions.
- Delete this event's expenses first, because their composite vendor/category FKs use RESTRICT.
- Delete the event row and use its existing cascades for memberships, budget categories, vendors, tasks, invitations, document metadata, and draft budget items. Roll back every write if any step fails.
- Shared event templates and template budget categories are never deleted. Unrelated events remain unchanged.
- Document metadata is deleted according to the SQL schema. External S3 objects are not deleted; this local feature does not add AWS storage infrastructure or object-deletion APIs. Guests are not represented by a table in the current schema.

## Local testing

Start the existing Docker MySQL container and backend with their current configuration. Create a disposable event, sign in as its OWNER, open Edit Event, and choose Delete Event. Verify the saved name and confirmation text, then confirm. Expect 204, removal from the switcher/list, cleared selection/details, navigation to Events, and “Event deleted successfully.”

Cancel/X/Escape/backdrop dismissal of confirmation must not delete anything or discard the edit draft. Simulate a network/server failure to verify the dialog keeps the event/draft and permits retry. Check CO_PLANNER/nonmember tokens return 403, absent events return 404, and payment-history events return 409 with every row retained.

Automated backend checks, including all optional MySQL tests (PowerShell, from `backend`):

```powershell
npm run typecheck
npm run build
$env:EVENTWISE_MYSQL_TEST = '1'
$env:TEST_MYSQL = '1'
npm test
```

The deletion integration tests create isolated fixtures, verify FK cleanup and other-event/template preservation, inject a failure after expense deletion to prove rollback, then clean up their own fixtures. Frontend checks: `npm run typecheck`, `npm run build`, and `npm test` from `frontend/organizer`.
