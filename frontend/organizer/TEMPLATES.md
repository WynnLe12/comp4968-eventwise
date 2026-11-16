# Event Templates API configuration

The Templates page (`src/features/events/Templates.tsx`) and Create Event selector/
Budget Allocation Preview (`src/features/events/components/CreateEventModal.tsx`)
already load the catalog and details through `src/services/eventTemplates.ts`.
There are no hardcoded template options or allocations to replace. The hardcoded
keys on the Templates page only select decorative artwork, with a fallback for
unknown types.

Use these public Vite settings in `.env.local` (restart Vite after changes), or
in the frontend hosting build environment before rebuilding:

```env
VITE_API_BASE_URL=/api
VITE_TEMPLATES_API_BASE_URL=https://hd63bpgxm8.execute-api.us-west-2.amazonaws.com/prod
```

Keep any existing `VITE_API_BASE_URL` value for the rest of the application. The
Templates-only service reads the override and only routes catalog reads to AWS; Events and Budget continue
using the shared API base. If the override is omitted/blank, Templates also uses
VITE_API_BASE_URL, which defaults to the existing local `/api` Vite proxy.
Do not put secrets in VITE variables. `.env.local` is intentionally gitignored;
`.env.example` documents the settings for other developers.

Selecting a type fetches `/event-templates/{templateId}`. The UI displays categories
in returned order, accepts decimal-string percentages, and uses the existing
integer-cent allocation helper. Loading, empty, error/retry and cancellation/stale
response handling are retained. Empty categories have an explicit preview message.

Create Event still submits only the selected real `template_id`, event fields and
budget through the existing authenticated Event API. Its validation, callbacks,
authentication and POST destination are unchanged. Valid defaults totaling 100%
are still required by this form. Reading the AWS catalog does not migrate the
Event API: the creation backend must recognize the selected template IDs from the
same catalog/database. Local and RDS template IDs are not guaranteed to match.

Checks: `npm run typecheck`, `npm test`, and `npm run build`.
