# Client Reporting Follow-up Board

A single-admin board for tracking which client reports are owed and which
delivered reports are still unpaid — built from the Client Reporting
Follow-up Board PRD, adapted to run on a self-hosted Hostinger VPS (Node +
Express + Postgres + Docker + Traefik), the same pattern as the Rent
Tracker app.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full deployment plan,
including the exact VPS/Postgres/Traefik values this app reuses.

## Local development

```bash
npm install
cp .env.example .env.local
# fill in DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD_HASH (see below)
set -a; source .env.local; set +a
node src/migrate.js   # applies sql/schema.sql
node src/app.js
```

Generate an admin password hash:

```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

## Deploying (Docker, on the VPS)

The included `docker-compose.yml` builds the app from this repository and
joins it to the VPS's existing shared Postgres and Traefik networks. See
`DEPLOYMENT.md` for the full runbook — provisioning the database, the
`.env` file on the VPS (see `.env.deploy.example`), and DNS.

## Stack

- Node.js 20 + Express + EJS (server-rendered, no build step)
- PostgreSQL (plain `pg` driver — no ORM, no native dependencies)
- express-session + connect-pg-simple (session store lives in Postgres)
- Single admin login (bcrypt)
