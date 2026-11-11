# Local MySQL setup

How to run the EventWise MySQL database on your machine for development and tests. AWS uses Amazon RDS. This local copy is for development only.

The database port is bound to `127.0.0.1`, so only your own machine can connect, not other devices on your network.

**Schema vs. seed data:**

- The **schema** (`database/mysql/schemas/eventwise_schema.sql`) creates the empty tables. Docker loads it automatically the first time MySQL starts.
- **Seed data** (`database/mysql/seeds/*.sql`) fills those tables with fake events, vendors, expenses and so on, so there's something to develop and test against. You load it with `npm run db:seed`.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and **running**.
- Node.js 22 (`nvm use` in the repo root picks it up from `.nvmrc`). The `npm run db:*` scripts need it.
- Check it works:

  ```bash
  docker --version
  docker compose version
  node -v
  ```

## First-time setup

1. **Create your local env file** (from the repo root, `comp4968-eventwise/`)

   ```bash
   cp .env.example .env
   ```

   On Windows (Command Prompt), use `copy .env.example .env`. `.env` is git-ignored.

2. **Start MySQL and load the seed data** (from `backend/`)

   ```bash
   cd backend
   npm run db:up
   npm run db:seed
   ```

   - `db:up` waits until MySQL is healthy. The first run downloads the `mysql:8.0` image and loads [`eventwise_schema.sql`](../../database/mysql/schemas/eventwise_schema.sql), which takes a minute.
   - `db:seed` loads every file in [`database/mysql/seeds/`](../../database/mysql/seeds/).

   The npm scripts don't need `npm install`; they only use Docker and Node. Without npm, use `docker compose up -d` from the repo root, then `docker compose ps` until `STATUS` shows `Up ... (healthy)`.

3. **Check that it loaded**

   ```bash
   docker exec -it eventwise-mysql mysql -ueventwise -plocalpass eventwise -e "SHOW TABLES; SELECT vendor_id, name FROM vendors;"
   ```

   You should see the tables (`events`, `budget_categories`, `vendors`, `expenses`, …) and 10 vendors. A warning about using a password on the command line is normal.

## npm scripts

Run these from the `backend/` folder:

| Script | What it does | When to use it |
| --- | --- | --- |
| `npm run db:up` | Starts MySQL and waits until it's healthy. On an empty volume, it also loads the schema | Start of a work session |
| `npm run db:seed` | Loads every `.sql` file in `database/mysql/seeds/`, in name order. Each file clears its own rows first, so this resets the seed data and keeps the tables | After tests or experiments changed the data |
| `npm run db:seed -- <file> [<file> …]` | Loads only the named seed files | Re-running just your feature's seed |
| `npm run db:reset` | Deletes the database volume, starts MySQL (schema reloads), then runs `db:seed` | After the schema changes, or when anything is broken |

How they work:

- `db:up` and `db:reset` call `docker compose -f ../docker-compose.yml …`, so they find the compose file from `backend/`.
- `db:seed` runs [`scripts/db-seed.mjs`](../../scripts/db-seed.mjs). It pipes each seed file into the `mysql` client inside the `eventwise-mysql` container (`docker exec -i`), so you don't need a MySQL client installed. It stops at the first file that fails and prints the MySQL error.
- `db:seed` uses Node rather than a shell loop, so the same script works on macOS, Linux and Windows.

## Connection details

| Setting       | Value                          |
| ------------- | ------------------------------ |
| Host          | `127.0.0.1`                    |
| Port          | `3307` (not the default 3306)  |
| User          | `eventwise`                    |
| Password      | `localpass`                    |
| Database      | `eventwise`                    |
| Root password | `localroot` (admin tasks only) |

These match `.env.example`. They only work against your local container; never use them in AWS.

You can use these in any GUI client (MySQL Workbench, DBeaver, TablePlus or a VS Code MySQL extension).

> **Note:** the backend doesn't load `.env` automatically yet, because no dotenv loader is configured. Until one is added, export the `DB_*` variables in your shell, or have whoever adds the database connection code add a loader.

## Daily commands

| Goal                              | Command                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Start the database                | `npm run db:up` (in `backend/`) or `docker compose up -d`                 |
| Reset the seed data               | `npm run db:seed` (in `backend/`)                                         |
| Rebuild everything                | `npm run db:reset` (in `backend/`)                                        |
| Check status                      | `docker compose ps`                                                       |
| Open a MySQL shell                | `docker exec -it eventwise-mysql mysql -ueventwise -plocalpass eventwise` |
| View logs                         | `docker compose logs -f` (Ctrl+C stops viewing; MySQL keeps running)      |
| Stop for the day (keeps data)     | `docker compose stop`                                                     |
| Remove the container (keeps data) | `docker compose down`                                                     |

Inside the MySQL shell, try `SHOW TABLES;`, `DESCRIBE vendors;` or `SELECT * FROM vendors;`. Type `exit` to leave.

## Seed data

### What's there now

| File | Owner | Contents |
| --- | --- | --- |
| [`01_base_seed.sql`](../../database/mysql/seeds/01_base_seed.sql) | Shared | 2 events, 3 members, 9 budget categories. Stand-ins until Features 1 and 3 have their own seeds |
| [`02_vendors_seed.sql`](../../database/mysql/seeds/02_vendors_seed.sql) | Feature 5 | 10 vendors, plus the expenses and payments linked to them |

The data:

- **Event 1, Maya & Eli's Wedding.** This is the main demo event, with 8 vendors covering every booking status.
- **Event 2, Sam's 30th Birthday.** It exists to test that one event can't see another's data.
- **Fake Cognito users:**

  | User | Role |
  | --- | --- |
  | `user-maya` | Owner of event 1 |
  | `user-eli` | Co-planner of event 1 |
  | `user-sam` | Owner of event 2 only, so `user-sam` should get a 403 on event 1 |

Each seed file starts with a comment listing what it contains and the results you should expect. For example, `02_vendors_seed.sql` lists every vendor's paid total, balance and next due date.

### Examples

Reset the data after a test changed it:

```bash
cd backend
npm run db:seed
```

```
Seeding 01_base_seed.sql ... done
Seeding 02_vendors_seed.sql ... done
```

Re-run only the vendor seed:

```bash
npm run db:seed -- 02_vendors_seed.sql
```

Check a value against the seed file's expected results:

```bash
docker exec -it eventwise-mysql mysql -ueventwise -plocalpass eventwise -e \
  "SELECT vendor_id, paid_total, next_due_date FROM vendor_payment_totals WHERE event_id = 1;"
```

Vendor 3 (Fleur & Fern) should show `850.00` paid: a 1000.00 deposit minus a 150.00 refund.

### Adding a seed file for your feature

1. Create `database/mysql/seeds/NN_<feature>_seed.sql`. The number sets the load order: a file must come **after** every file whose rows it points to. Use `01_base_seed.sql`'s events and categories rather than creating your own.
2. Start with `USE eventwise;`, then a **reset block** that deletes the rows this file inserts. Then `db:seed` can run it again and again without "Duplicate entry" errors.
3. Use **explicit IDs**, such as `task_id = 1`, so tests can refer to known rows. Keep to the events in the base seed (1 and 2).
4. Put a comment at the top saying what the data covers and what results to expect.
5. Run `npm run db:seed` twice. The second run must also succeed.

Template, using the post-MVP `tasks` table as an example:

```sql
-- Tasks seed (Feature 12). LOCAL DEVELOPMENT AND TESTS ONLY.
-- Needs 01_base_seed.sql (events 1-2).
-- Event 1: one open task, one completed task. Event 2: one task.

USE eventwise;

-- Reset this file's rows.
DELETE FROM tasks WHERE event_id IN (1, 2);

INSERT INTO tasks (task_id, event_id, title, due_date, is_completed) VALUES
 (1, 1, 'Book the venue',        '2026-12-01', TRUE),
 (2, 1, 'Send save-the-dates',   '2027-02-01', FALSE),
 (3, 2, 'Order the cake',        '2027-02-20', FALSE);
```

Rules:

- **Local only.** The reset blocks delete events 1 and 2 and everything under them. Don't run the seeds on RDS or any shared database without agreeing with the team first. RDS also needs real Cognito subs in `event_members`, not `user-maya`.
- **Don't edit another feature's seed file** to make yours work. If you need a different event or category, add it to `01_base_seed.sql` and tell the team.
- **No real personal data.** Use made-up names, `.example` email domains and `(555)` phone numbers.

## After the schema changes

The schema only loads when the database volume is empty. When `eventwise_schema.sql` changes (for example after you pull a teammate's update), rebuild the database (from `backend/`):

```bash
npm run db:reset
```

Without npm, run the same steps from the repo root:

```bash
docker compose down -v
docker compose up -d
```

Then run `npm run db:seed`.

**Warning:** `down -v` and `db:reset` delete all local data. The schema and seed data are reloaded from scratch.

## Troubleshooting

| Problem                                        | Fix                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot connect to the Docker daemon`          | Start Docker Desktop, then retry.                                                                                                                                  |
| `port is already allocated` / port 3307 in use | Something else is on 3307. Find it with `lsof -iTCP:3307 -sTCP:LISTEN` (macOS/Linux). If it's an old `eventwise-mysql` container, run `docker compose down` first. |
| New or changed tables are missing              | The schema only runs on first start. Run `npm run db:reset`, or `docker compose down -v && docker compose up -d`.                                                  |
| Status stays `starting` or becomes `unhealthy` | Check `docker compose logs mysql`. An SQL error in the schema file stops the init, so fix the SQL and then reset with `down -v`.                                   |
| `Access denied for user 'eventwise'`           | Check you're using port **3307** and password `localpass`. If you changed the credentials in `docker-compose.yml`, reset with `down -v` so the user is recreated.  |
| App can't connect on `localhost`               | Use `127.0.0.1`. Some clients turn `localhost` into a Unix socket connection instead of TCP.                                                                       |
| `db:seed` says `No such container`             | MySQL isn't running. Run `npm run db:up` first.                                                                                                                     |
| Seed fails with `ERROR 1452 … foreign key constraint fails` | A row points to something that doesn't exist yet. Check the file's number puts it after the files it depends on, and that it only uses the base seed's events and categories. |
| Seed fails with `ERROR 1062 Duplicate entry`   | The file's reset block doesn't delete everything it inserts. Add the missing `DELETE`.                                                                              |
| Seed fails with `ERROR 3819 Check constraint … is violated` | The seed row breaks a rule in the schema, for example a Researching vendor with a quote. Fix the row.                                                     |
