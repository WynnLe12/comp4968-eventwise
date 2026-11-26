# Task API contract (Feature 12)

The task routes run in their own Lambda, `eventwise-tasks` (`backend/task-service/`), behind the shared REST API and its Cognito authorizer. The data lives in the `tasks` and `template_tasks` tables in RDS MySQL. `eventwise_schema.sql` is the source of truth.

## 1. Routes

Every route needs a Cognito **access token** as `Authorization: Bearer <token>`. Every route checks that the signed-in user belongs to `{eventId}` (`event_members`, either role) before doing anything else.

| Method | Path                                    | Request body                         | Success                                               |
| ------ | --------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| GET    | `/events/{eventId}/tasks`               | none                                 | `200`, `{ tasks: Task[], progress: Progress }`        |
| POST   | `/events/{eventId}/tasks`               | [editable fields](#editable-fields) | `201`, the created Task                               |
| POST   | `/events/{eventId}/tasks/from-template` | none                                 | `201`, `{ created: number, tasks: Task[] }`           |
| GET    | `/events/{eventId}/tasks/{taskId}`      | none                                 | `200`, one Task                                       |
| PATCH  | `/events/{eventId}/tasks/{taskId}`      | only the fields that change          | `200`, the updated Task                               |
| DELETE | `/events/{eventId}/tasks/{taskId}`      | none                                 | `204`, no body (Owner only)                           |

- **Complete and reopen** are `PATCH { "isCompleted": true }` and `PATCH { "isCompleted": false }`. There are no separate routes.
- **The list order** is open tasks first, then by due date (undated last), then oldest first. Tabs (All / To do / Completed) and the assignee filter are done in the browser from the full list.
- **`from-template`** copies the event template's default checklist as ordinary tasks. It's safe to call twice: the second call returns `created: 0` and adds nothing. `tasks` is the full list afterwards.
- POST and PATCH return the task as read back from the database.

---

## 2. JSON shapes

### Task

```json
{
  "id": "12",
  "eventId": "1",
  "title": "Book ceremony musicians",
  "description": null,
  "dueDate": "2027-06-02",
  "isCompleted": false,
  "completedAt": null,
  "assignee": { "memberId": "3", "role": "CO_PLANNER", "displayName": "Min B." },
  "source": "TEMPLATE",
  "createdAt": "2026-11-24T18:02:11Z",
  "updatedAt": "2026-11-24T18:02:11Z"
}
```

| Field         | Type             | Editable          | Notes                                                                                    |
| ------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `id`          | string           | no                | `tasks.task_id`                                                                          |
| `eventId`     | string           | no                | Comes from the URL. Ignored in a request body                                            |
| `title`       | string           | **yes, required** | 1–200 characters                                                                         |
| `description` | string \| null   | yes               | Up to 2000 characters                                                                    |
| `dueDate`     | string \| null   | yes               | `YYYY-MM-DD`, a calendar date with no time zone                                          |
| `isCompleted` | boolean          | yes               | `false` for new tasks unless sent                                                        |
| `completedAt` | string \| null   | no                | ISO UTC. Set by the server on the false → true change, cleared on reopen                 |
| `assignee`    | object \| null   | via `assignedMemberId` | The Owner or a Co-Planner of this event. `displayName` can be `null`               |
| `source`      | `MANUAL` \| `TEMPLATE` | no          | Where the task came from. Template tasks are fully editable and stay `TEMPLATE`          |
| `createdAt`, `updatedAt` | string | no              | ISO UTC                                                                                  |

### Progress

```json
{ "total": 36, "completed": 24, "open": 12, "percentComplete": 67 }
```

`percentComplete` is rounded to the nearest whole percent, the same as the dashboard (`docs/api/dashboard.md`), so both pages always show the same number. 0 tasks is `0`.

### Editable fields

```json
{ "title": "...", "description": "...", "dueDate": "2027-06-02", "assignedMemberId": "3", "isCompleted": false }
```

- `assignedMemberId` is an `event_members.member_id` (the `member_id` from `GET /events/{eventId}/members`). A number (`3`) is accepted too. `null` unassigns.
- Strings are trimmed, and an empty or whitespace-only string is saved as `null`.
- Any other key (`id`, `eventId`, `completedAt`, `source`, unknown keys) is **ignored**, not rejected.

### Dates in the browser

**Overdue** and **due this week** are worked out in the browser from `dueDate` and the user's **local** date. The server runs in UTC and doesn't know the user's time zone, so doing it on the server would flip tasks to overdue at 4 pm Pacific. Don't pass `dueDate` through `new Date()` for display: use `formatCalendarDate` in `utils/dateFormat.ts`.

---

## 3. Who can do what

| Action                                            | Owner | Co-Planner |
| ------------------------------------------------- | :---: | :--------: |
| List, view, create, edit, assign, complete, reopen | ✓     | ✓          |
| Add the suggested checklist (`from-template`)     | ✓     | ✓          |
| Delete a task                                     | ✓     | 403 `OWNER_REQUIRED` |

- The assignee must be on **this** event's planning team. Anything else (a member of another event, a removed co-planner, an ID that doesn't exist) is a 422 on `assignedMemberId`, never 404, so the API doesn't reveal other events' member IDs.
- When a co-planner is removed from the event, their tasks stay and become unassigned.
- The assignee check runs in the same transaction as the write, with the member row locked, so it can't race a co-planner removal.

---

## 4. Errors

Every error from the Lambda uses this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Check the submitted fields.", "fields": { "title": "Task name is required" } } }
```

`fields` appears only on `422`. Its keys are the JSON field names, so each message can go straight under its input.

| Status | `code`             | When                                                                  |
| ------ | ------------------ | --------------------------------------------------------------------- |
| 400    | `INVALID_JSON`     | The request body isn't valid JSON                                     |
| 401    | (API Gateway)      | No token, or an expired or invalid token                              |
| 403    | `FORBIDDEN`        | Not a member of this event. Same 403 when the event doesn't exist     |
| 403    | `OWNER_REQUIRED`   | A co-planner tries to delete a task                                   |
| 404    | `NOT_FOUND`        | The task doesn't exist, or it belongs to another event                |
| 409    | `NO_TEMPLATE`      | `from-template` on an event that wasn't created from a template       |
| 422    | `VALIDATION_ERROR` | A field is invalid. `fields` keys: `title`, `description`, `dueDate`, `assignedMemberId`, `isCompleted` |
| 500    | `INTERNAL_ERROR`   | Anything unexpected. The message never includes details               |

Field messages:

| Field              | Message                                           |
| ------------------ | ------------------------------------------------- |
| `title`            | `Task name is required`, `Enter text`, `Keep this under 200 characters` |
| `description`      | `Enter text`, `Keep this under 2000 characters`   |
| `dueDate`          | `Enter a valid date`                              |
| `assignedMemberId` | `Choose someone on this event's planning team`    |
| `isCompleted`      | `Must be true or false`                           |

Membership is checked first on every route, so a non-member gets 403 even for a task ID that exists, and never learns whether it does.

---

## 5. Examples

### Create

```http
POST /events/1/tasks
{ "title": "Book ceremony musicians", "dueDate": "2027-06-02", "assignedMemberId": "3" }
```

`201` with the Task (`isCompleted: false`, `completedAt: null`, `source: "MANUAL"`).

### Complete, then reopen

```http
PATCH /events/1/tasks/12
{ "isCompleted": true }
```

`200` with `completedAt` set. Editing only the title of a completed task keeps the original `completedAt`. `PATCH { "isCompleted": false }` clears it.

### Assignee from another event

```http
PATCH /events/1/tasks/12
{ "assignedMemberId": "99" }
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Check the submitted fields.", "fields": { "assignedMemberId": "Choose someone on this event's planning team" } } }
```

### Suggested checklist

```http
POST /events/1/tasks/from-template
```

`201` `{ "created": 11, "tasks": [...] }`. Each task's due date is the event date minus the template task's `days_before_event`, or `null` when the event has no date.

---

## 6. Schema this contract depends on

Migration [005_tasks_checklists.sql](../../database/mysql/migrations/005_tasks_checklists.sql), already folded into `eventwise_schema.sql`:

- **`template_tasks`**: the default checklist per event template (`title`, `description`, `days_before_event`, `sort_order`). 005 creates the table, and [006_template_checklists.sql](../../database/mysql/migrations/006_template_checklists.sql) fills in a list for all five templates.
- **`tasks.completed_at`**, with `chk_task_completed_at`: completed tasks always have a time, open tasks never do.
- **`tasks.template_task_id`**, with `uq_task_template (event_id, template_task_id)` so generating twice can't duplicate.
- **`tasks.updated_at`** and the index `idx_task_event_open (event_id, is_completed, due_date)`.

## 7. Decisions

- **Separate Lambda**, so the feature deploys on its own.
- **Only the Owner deletes.** This stops a co-planner from quietly removing the Owner's checklist. Everything else is open to both roles.
- **No `/tasks/summary` route.** The dashboard already shows task progress and upcoming tasks from `GET /events/{eventId}/dashboard` (Feature 10), which reads the same `tasks` table.
- **Rounding to the nearest percent**, to match the dashboard. With many tasks, 199 of 200 shows as 100%. If the team prefers rounding down, change `task-service/services/progress.ts`, `features/planning/taskRules.ts` and `event-service/services/dashboardService.ts` together.
