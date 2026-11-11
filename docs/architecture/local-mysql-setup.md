# Local MySQL setup

How to run the EventWise MySQL database on your machine for development and tests. AWS uses Amazon RDS. This local copy is for development only.

The database port is bound to `127.0.0.1`, so only your own machine can connect, not other devices on your network.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and **running**.
- Check it works:

  ```bash
  docker --version
  docker compose version
  ```

## First-time setup

Run these from the repo root (`comp4968-eventwise/`).

1. **Create your local env file**

   ```bash
   cp .env.example .env
   ```

   On Windows (Command Prompt), use `copy .env.example .env`. `.env` is git-ignored.

2. **Start MySQL**

   ```bash
   docker compose up -d
   ```

   The first run downloads the `mysql:8.0` image and loads [`database/mysql/schemas/eventwise_schema.sql`](../../database/mysql/schemas/eventwise_schema.sql). This takes a minute.

3. **Wait until it's healthy**

   ```bash
   docker compose ps
   ```

   Repeat until `STATUS` shows `Up ... (healthy)`.

4. **Check that the schema loaded**

   ```bash
   docker exec -it eventwise-mysql mysql -ueventwise -plocalpass eventwise -e "SHOW TABLES;"
   ```

   You should see tables such as `events`, `budget_categories`, `vendors` and `expenses`. A warning about using a password on the command line is normal.

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
| Start the database                | `docker compose up -d`                                                    |
| Check status                      | `docker compose ps`                                                       |
| Open a MySQL shell                | `docker exec -it eventwise-mysql mysql -ueventwise -plocalpass eventwise` |
| View logs                         | `docker compose logs -f` (Ctrl+C stops viewing; MySQL keeps running)      |
| Stop for the day (keeps data)     | `docker compose stop`                                                     |
| Remove the container (keeps data) | `docker compose down`                                                     |

Inside the MySQL shell, try `SHOW TABLES;`, `DESCRIBE vendors;` or `SELECT * FROM vendors;`. Type `exit` to leave.

## After the schema changes

The schema only loads when the database volume is empty. When `eventwise_schema.sql` changes (for example after you pull a teammate's update), reset the database:

```bash
docker compose down -v
docker compose up -d
```

**Warning:** `-v` deletes all local data. The schema is reloaded from scratch.

## Troubleshooting

| Problem                                        | Fix                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot connect to the Docker daemon`          | Start Docker Desktop, then retry.                                                                                                                                  |
| `port is already allocated` / port 3307 in use | Something else is on 3307. Find it with `lsof -iTCP:3307 -sTCP:LISTEN` (macOS/Linux). If it's an old `eventwise-mysql` container, run `docker compose down` first. |
| New or changed tables are missing              | The schema only runs on first start. Run `docker compose down -v && docker compose up -d`.                                                                         |
| Status stays `starting` or becomes `unhealthy` | Check `docker compose logs mysql`. An SQL error in the schema file stops the init, so fix the SQL and then reset with `down -v`.                                   |
| `Access denied for user 'eventwise'`           | Check you're using port **3307** and password `localpass`. If you changed the credentials in `docker-compose.yml`, reset with `down -v` so the user is recreated.  |
| App can't connect on `localhost`               | Use `127.0.0.1`. Some clients turn `localhost` into a Unix socket connection instead of TCP.                                                                       |
