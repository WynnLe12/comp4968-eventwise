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
2. Initialize the React applications and backend packages when development begins; this scaffold only creates folders and documentation.
3. Copy `.env.example` to a local `.env` and fill in non-committed configuration values.
4. Agree on API contracts and database migrations before connecting features.
5. Use feature branches and pull requests; do not commit credentials or Terraform state.

## Development conventions

- Keep feature-specific UI and logic in the matching `features/` folder.
- Put reusable frontend code in `components/`, `services/`, and `hooks/`.
- Put shared backend authentication and database helpers in `backend/shared/`.
- Document new API endpoints in `docs/api/` and schema changes through migrations.
- Add post-MVP features to existing modules where appropriate rather than creating duplicate applications.
