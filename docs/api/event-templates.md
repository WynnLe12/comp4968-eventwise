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
The frontend still uses mock templates and needs separate API integration.
