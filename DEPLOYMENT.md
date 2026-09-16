# Deployment plan — Client Reporting Follow-up Board

This app is built and locally verified (see "What's been tested" below). It is
not yet deployed — that step needs the Hostinger VPS connector active in a
chat session. Once it is, this is the exact plan to execute, reusing the same
VPS, Postgres instance and Traefik proxy as the Rent Tracker app.

## Target environment (reusing what's already on the VPS)

| Item | Value |
|---|---|
| VPS host | srv1864091.hstgr.cloud (same VPS as Rent Tracker) |
| VPS public IP | 76.13.23.117 |
| Existing shared Postgres container | postgresql-jld5-postgresql-1 |
| Postgres network | postgresql-jld5_default |
| Existing Traefik (via n8n) network | n8n_default |
| TLS cert resolver | mytlschallenge |
| Base image | public.ecr.aws/docker/library/node:20-alpine (avoids Docker Hub rate limit) |

## New resources this app needs

| Item | Value |
|---|---|
| Docker project name | report-followups |
| Container / service name | report-app |
| Named volume | report_followups_data |
| Internal port | 4001, published to 127.0.0.1:4001 only |
| New database | reportsdb |
| New DB user | reportsapp_user |
| Proposed public URL | https://reports.msaii.cloud (change if you prefer another subdomain) |

## Steps (per the Hostinger VPS Docker-deploy skill)

1. **Provision the database.** One-off compose service joining
   `postgresql-jld5_default`, running `psql` against
   `postgresql-jld5-postgresql-1` to `CREATE DATABASE reportsdb`,
   `CREATE USER reportsapp_user`, and grant privileges — same pattern as
   Rent Tracker.
2. **Write the app's files to the named volume.** All source is already
   finalized in this delivery (`src/`, `views/`, `public/`, `sql/`,
   `package.json`). These get heredoc-embedded into one or more
   `restart: "no"` compose deploys, staying under the ~6KB-per-call payload
   limit, escaping every literal `$` as `$$` (this app has none in its own
   source, but the bcrypt hash placed in the compose `environment:` list
   will need it — see step 4).
3. **Verify the writes landed** (`ls -la /app`, `cat` a file or two) before
   moving on.
4. **Deploy the final "install + start" compose**:
   - `npm install --omit=dev`
   - `psql -f sql/schema.sql` (or run schema via a one-off `db-init`-style
     step) against `reportsdb`
   - `exec node src/app.js`
   - `restart: unless-stopped`, port published to `127.0.0.1:4001` only
   - Environment: `DATABASE_URL`, `SESSION_SECRET` (generate a random 32+
     char string), `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (bcrypt hash —
     **escape every `$` as `$$`** in the compose file), `OWNER_ID`,
     `DEFAULT_CURRENCY`, `NODE_ENV=production`.
   - No Alpine/OpenSSL gotcha here — this app uses the `pg` driver, not
     Prisma, so no native OpenSSL dependency at all.
5. **Join `n8n_default`** and add Traefik labels:
   ```
   traefik.enable=true
   traefik.http.routers.report-followups.rule=Host(`reports.msaii.cloud`)
   traefik.http.routers.report-followups.tls=true
   traefik.http.routers.report-followups.entrypoints=web,websecure
   traefik.http.routers.report-followups.tls.certresolver=mytlschallenge
   traefik.http.services.report-followups.loadbalancer.server.port=4001
   ```
6. **Add the DNS A record**: `reports.msaii.cloud` → `76.13.23.117`.
7. **Confirm `trust proxy` is set** (it already is, in `src/app.js`) —
   otherwise the session cookie silently never sets behind Traefik.
8. **Change the placeholder admin password** immediately after first login.

## What's been tested locally (Postgres 16, Node 20)

- Schema applies cleanly: table, constraints, stage-guard trigger, overdue
  function, both derived views.
- Login: wrong credentials refused with a clear message; correct
  credentials establish a session; `/board` redirects unauthenticated
  requests to `/login`.
- Empty board shows "The table is empty" with no money figure (per PRD
  3.3 — no fake zero).
- Adding a client: appears immediately, correct fee formatting, correctly
  flagged **Overdue** when the report due date is in the past.
- Duplicate client-month: refused with "That client already has a row for
  this month." — no row added.
- Invalid month format and zero/blank fee: both refused with the exact
  messages from PRD Section 3.8, nothing saved.
- Advance Due → Sent: stage pill updates, **Overdue badge correctly
  disappears** (Sent is never red, per the truth table in PRD 3.4).
- Undo Sent → Due: reverts stage and the overdue badge reappears
  correctly.
- The two money figures (Not yet sent / Sent, not paid) move correctly as
  rows change stage.

## Known simplifications vs. the original PRD

The PRD's brief specifies Next.js + Vercel + Supabase Auth + RLS. This
build instead follows your proven Hostinger VPS + Docker + shared Postgres
pattern (same as Rent Tracker), with these deliberate differences:

- **Single admin login** (bcrypt + express-session), not per-user Supabase
  Auth. `owner_id` is still present on every row and defaults to a fixed
  UUID, so if you ever need real multi-user logins later, only the auth
  layer and query filters change — the schema and stage-guard logic do
  not (this preserves the PRD's C5 hedge).
- **No Postgres RLS** — isolation is enforced by the single-admin session
  instead, since there's one signed-in identity. If you add multi-user
  auth later, RLS policies from the original PRD (Section 4.7) can be
  added directly onto this same schema.
- **No optimistic client-side UI** — writes go through a normal form POST
  and full page reload rather than a fetch-based optimistic update. The
  server-side refusal behavior (wrong-order stage jump, duplicate month,
  validation) is identical to the PRD's spec either way.
