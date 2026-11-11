# EventWise

Cloud-based event planning platform. The MVP focuses on organizer workflows; guest-facing self-service is planned for post-MVP.

## MVP scope and team ownership

| Group | Area | MVP scope |
| --- | --- | --- |
| A â€” Event & Budget | `frontend/organizer/src/features/events`, `budgets`, `auth`; corresponding backend services | Sign-in and event workspaces; budget categories and automatic allocation; basic event types/templates |
| B â€” Vendors & Expenses | `frontend/organizer/src/features/vendors`, `expenses`; corresponding backend services | Vendor management and expense tracking |
| C â€” Guests & Security | `frontend/organizer/src/features/guests`; `backend/guest-service`; shared authentication | Organizer-side guest list management and shared security integration |

Group assignments describe ownership during MVP; source code remains organized by feature so ownership can change later.

## Post-MVP

`frontend/guest-portal/` is reserved for guest-facing invitations, RSVP, event details and schedules. Additional enhancements can be added to existing feature folders without duplicating MVP code. The notification service is also a placeholder for future messaging workflows.

## Repository structure

- `frontend/organizer/`: organizer React application; feature folders for auth, events, budgets, expenses, vendors and guests.
- `frontend/guest-portal/`: future guest-facing React application (post-MVP).
- `backend/`: logical Node.js/AWS Lambda service modules and shared code. A folder does not imply a separate deployment is required.
- `database/mysql/`: relational schemas, migrations and seeds for Amazon RDS MySQL.
- `database/dynamodb/`: DynamoDB definitions if needed.
- `infrastructure/terraform/`: shared AWS infrastructure configuration with development and production environments.
- `docs/`: architecture, API, MVP and post-MVP documentation (no group-specific README files).
- `scripts/`: developer and deployment scripts.
- `tests/`: integration and cross-service tests.
- `.github/workflows/`: CI/CD workflows.

## Planned cloud architecture

React frontends; AWS Amplify hosting; Amazon Cognito authentication; Amazon API Gateway and AWS Lambda backend; Amazon RDS MySQL for relational data; DynamoDB where appropriate; Amazon S3 for files. Final resource choices and deployments should be documented under `docs/architecture/`.

## Getting started

1. Clone the repository.
2. Use Node.js 22.12 or newer and npm (validated with Node.js 24).
3. Install dependencies: `npm --prefix frontend/organizer ci` and `npm --prefix backend ci`.
4. Start the frontend: `npm --prefix frontend/organizer run dev` (normally port 5173).
5. In another terminal, start the backend: `npm --prefix backend run dev` (normally `http://127.0.0.1:3000`).
6. Agree on API contracts and database migrations before connecting features. Use feature branches and pull requests; do not commit credentials or Terraform state.

## TypeScript setup and validation

The organizer uses React 19, Vite, React Router and strict TypeScript. Shared UI
components live in `frontend/organizer/src/components/ui/`, exported by `index.ts`.
Feature components, routing and mock-data types retain their existing structure.
The frontend uses ES modules, with Vite producing the browser build.

The backend is a new TypeScript scaffold: no JavaScript backend, framework,
authentication, database connection or business API existed to migrate. Existing
service folders are preserved. `backend/server.ts` is a local Node.js HTTP entry
point with `GET /health` returning `{"status":"ok"}`; other routes return JSON 404
responses. It uses CommonJS via NodeNext and compiles to `backend/dist`. This local
entry point does not replace the planned Lambda deployment architecture.

| Check | Frontend | Backend |
| --- | --- | --- |
| Type check | `npm --prefix frontend/organizer run typecheck` | `npm --prefix backend run typecheck` |
| Build | `npm --prefix frontend/organizer run build` | `npm --prefix backend run build` |
| Production runtime | `npm --prefix frontend/organizer run preview` | `npm --prefix backend start` |
| Tests | No existing test suite | `npm --prefix backend test` |

Backend tests cover health, unknown routes and unsupported methods. Frontend assets
are emitted to `frontend/organizer/dist`. The eventual SPA host must route
application URLs back to `index.html` for React Router.

Backend environment variables `HOST` and `PORT` default to `127.0.0.1` and `3000`.
Set variables in your shell or deployment environment; no dotenv loader is
configured, so copying `.env.example` does not automatically load it into Node.js.
Use Vite's `VITE_` variables only for public frontend configuration. Never place
secrets in frontend variables. Environment files and build outputs are ignored.

## Current implementation limits

The organizer is a prototype using mock data and simulated sign-in. Create/save
dialogs, uploads, exports and several controls remain placeholders. Some
interactions update local component state only. There are no frontend API calls,
so business API compatibility cannot be checked until endpoints and integration
exist. Existing budget rounding and fixed summary indicators remain prototype
limitations outside this migration. Guest portal and cloud/database directories
remain scaffolds. The result is a runnable frontend and backend scaffold, not yet
a completed event-planning backend.

## Development conventions

- Keep feature-specific UI and logic in the matching `features/` folder.
- Put reusable frontend code in `components/`, `services/`, and `hooks/`.
- Put shared backend authentication and database helpers in `backend/shared/`.
- Document new API endpoints in `docs/api/` and schema changes through migrations.
- Add post-MVP features to existing modules where appropriate rather than creating duplicate applications.
