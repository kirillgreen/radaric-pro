# Deployment Guide

Radaric runs as a **single long-running Node.js service** — never as a
serverless function. One container runs two processes side by side: the Next.js
web app, and the story-aggregator worker that holds a persistent Telegram
connection. Any hosting platform therefore MUST:

- keep the process alive between requests and restart it on failure;
- allow a graceful stop window of at least 15 seconds;
- provide a PostgreSQL database.

**For the recommended self-hosting path, see [SELF_HOSTING.md](../SELF_HOSTING.md)**
(Docker Compose quick start, updating, minimum environment, feature→key map).
This guide documents the container contract any platform must reproduce, plus
migrations, health checks, backups and troubleshooting.

## 1. Deployment options

### 1.1 Docker Compose (recommended for self-hosting)

The repository ships `Dockerfile` and `docker-compose.yml`, which implement the
contract described here: Compose stack, first-account bootstrap, AI keys,
updating and backups. Follow [SELF_HOSTING.md](../SELF_HOSTING.md) and do not
duplicate its quick start here.

### 1.2 Container platform (Railway and similar)

Build from the repository `Dockerfile`, or run the same commands directly on the
platform:

| Step | Command |
|------|---------|
| Install | `npm ci` — run with `prisma/` present, because `postinstall` runs `prisma generate` |
| Build | `npm run build` (= `prisma generate && next build`) |
| Start | `sh scripts/start.sh`, as the container's PID 1 |

The build does not need a reachable database. The Dockerfile builds with a
placeholder `DATABASE_URL`; `next build` must succeed without one.

`sh scripts/start.sh` is the only supported entrypoint. It:

1. Runs `node scripts/migrate-safe.js` — applies migrations before anything
   starts (see §5).
2. Starts the worker: `npx tsx lib/story-aggregator/worker.ts`.
3. Starts the web app: `next start`, listening on `PORT` (default 3000).
4. Traps SIGTERM/SIGINT and forwards the signal to both children, then **waits
   for both to exit** before the container exits.

Why the entrypoint matters: the worker closes the Telegram session during
shutdown. If it is killed without that window, Telegram can invalidate the
session (`AUTH_KEY_DUPLICATED`) and every Telegram source stops until the
session is re-authenticated. NEVER background the worker with a bare
`... & next start`, and NEVER substitute `npm start` for the script. A graceful
stop budget of 15 seconds or more is REQUIRED (the worker's own shutdown budget
is an 8-second cap inside it).

Platform settings to mirror:

| Setting | Value |
|---------|-------|
| Replicas | 1 (see below) |
| Web port | `PORT` (default 3000) |
| Worker health port | `WORKER_HEALTH_PORT` (default 3001) — keep internal |
| Health check path | `/api/health` |
| Stop grace period / drain | ≥ 15 s |
| Restart policy | on failure |

The hosted radaric.pro service runs with: health check `/api/health` with a
120 s timeout, restart on failure (at most 5 retries), 30 s draining between
SIGTERM and SIGKILL, and the image built from the root `Dockerfile` with its own
`CMD` (no start-command override, so `scripts/start.sh` stays PID 1).

Run a **single replica**. The worker takes a PostgreSQL advisory lock so only
one worker may hold the Telegram session; additional replicas wait for the lock
and serve no purpose. The built-in rate limiter is in-process (per instance) and
does not coordinate across replicas, so horizontal scaling is not a supported
configuration.

### 1.3 Manual install (no Docker)

Node 22.23.4+ (or 24.22.1+ / 26.12.1+) plus a PostgreSQL database. The supported sequence is `npm ci`,
`npx prisma migrate deploy`, `npm run build`, then `sh scripts/start.sh` as the
long-running process — see
[SELF_HOSTING.md § Manual install](../SELF_HOSTING.md#manual-install-no-docker).
The same entrypoint rules apply: run `scripts/start.sh` as PID 1 and give it a
15-second stop window.

## 2. Environment variables at deploy time

### Required

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string. Use a **direct** connection, not a transaction-mode pooler: the worker's Telegram session lock uses session-level advisory locks, which a transaction pooler voids (`lib/story-aggregator/gramjs-lock.ts`). |
| `NEXTAUTH_SECRET` | Signs sessions. MUST be random and non-empty (`openssl rand -hex 32`) — a placeholder value would let anyone forge an admin session. |
| `TOKEN_ENC_KEY` | Seals users' Notion tokens at rest (`openssl rand -hex 32`). Without it a Notion token cannot be saved (503) and sealed ones cannot be read. Keep it stable; rotation via `TOKEN_ENC_KEY_PREVIOUS` and the backfill script: [SECURITY.md](SECURITY.md). |
| `NEXT_PUBLIC_APP_URL` | Public base URL of this instance, no trailing slash. REQUIRED on any non-Vercel host: it builds webhook callback URLs, email links and Stripe return URLs, and webhook creation throws without it. |
| one AI key | `OPENROUTER_API_KEY` (the default models route through OpenRouter) or `ANTHROPIC_API_KEY` — with Anthropic alone, switch filtering/synthesis/discovery and the two Telegram stages (story writer, deduplication) in Settings → AI Settings; material grouping stays OpenRouter. Without a key, sources report errors and the dashboard shows an "AI filtering is not configured" banner. |

### Optional groups

Every optional key is documented and verified against the code in
[`.env.example`](../.env.example); the feature→key map is in
[SELF_HOSTING.md](../SELF_HOSTING.md). The main groups:

- `SELF_HOSTED=true` and `ALLOW_UNVERIFIED_SIGNUP=1` — self-hosting mode.
- `NEXTAUTH_URL` — recommended fallback for reset links and OAuth callbacks.
  On a non-Docker install behind a proxy, leave it unset so NextAuth derives the
  host; NEVER set it to `localhost` on a server. The Docker compose file
  defaults it and `NEXT_PUBLIC_APP_URL` to `http://localhost:3000`, so on a real
  domain set both in `.env` (see
  [SELF_HOSTING.md](../SELF_HOSTING.md#quick-start-docker)).
- `RESEND_API_KEY` — email verification and password reset.
- `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_PUBLIC_URL` — media storage (see §4).
- `TWITTER_API_IO_KEY` — Twitter/X parsing.
- OAuth provider keys, `SENTRY_DSN`, worker and cost-tuning caps.
- `STRIPE_*` — only to sell subscriptions: see
  [STRIPE_TESTING.md](STRIPE_TESTING.md).

The platform provides `PORT` and `NODE_ENV` — do not set them yourself. On
Railway, `/api/health` also reports `RAILWAY_GIT_COMMIT_SHA` and
`RAILWAY_DEPLOYMENT_ID`.

**Telegram, Parallel and Notion credentials are NOT environment variables.**
They are stored in the database and configured in the app's Settings UI after
first login. `AUTH_USER` and `AUTH_PASSWORD_HASH` were removed and are ignored.

### Bootstrap the first account

The first account created in an empty database becomes ADMIN automatically;
ADMIN bypasses every access gate. Additional accounts:
`node scripts/create-user.js <user> <pass>` (add `--admin` for another
operator), or grant time-limited Lite access from the admin dashboard
(`POST /api/admin/comp-access`, ADMIN-only).

## 3. Database provisioning

- **PostgreSQL** is required (the schema uses Postgres enums and raw SQL).
- Provision one database per instance. Migrations own the schema entirely — do
  not pre-create tables.
- `DATABASE_URL` MUST point at a direct connection (§2).
- Keep the database on the same private network as the app where possible; the
  app opens a small connection pool, plus one dedicated single-connection client
  for the worker session lock.

## 4. Media storage (Cloudflare R2 or compatible)

Telegram photos and video thumbnails are stored in an S3-compatible bucket.
Cloudflare R2 is the tested provider; the client is the AWS S3 SDK with a custom
endpoint, so another S3-compatible store MAY work.

| Variable | Purpose |
|----------|---------|
| `R2_ENDPOINT` | S3 API endpoint of the bucket |
| `R2_BUCKET_NAME` | Bucket name |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Write credentials |
| `R2_PUBLIC_URL` | Public base URL media is served from (custom domain or the bucket's public URL); MUST be set or media URLs cannot be built |

Without R2 configuration, the app runs, but Telegram photos and thumbnails are
rendered without images. The bucket MUST be publicly readable at `R2_PUBLIC_URL`.

## 5. Migrations

Migrations run automatically on every boot: `scripts/start.sh` calls
`scripts/migrate-safe.js`, which runs `npx prisma migrate deploy`. Boot
migrations are idempotent, so restarting is always safe.

`migrate-safe.js` first attempts a normal deploy. If it fails, it inspects
`_prisma_migrations` for failed migrations, marks them resolved, and retries —
this repairs the class of failure where `ALTER TYPE ... ADD VALUE` fails inside
a transaction but still lands the enum value, leaving Prisma with a failed
migration row that blocks every later deploy.

Manual options (run from a machine that can reach the database):

```bash
node scripts/migrate-safe.js      # safe wrapper — preferred
npx prisma migrate deploy         # plain deploy, when no failed migrations exist
```

Rules when authoring migrations (developer-facing, enforced by convention):

- Put `ALTER TYPE ... ADD VALUE` in its own migration file with no other
  statements. Postgres does not make a new enum value visible inside the
  transaction that added it, and Prisma wraps each file in one transaction; a
  data migration that uses the value MUST be a separate, later file.
- Quote `@@map` table names in raw SQL (`"sources"`, not `"Source"`) — the
  Prisma model name and the Postgres table name differ. Check `schema.prisma`
  before writing SQL.
- The `build` script MUST run `prisma generate` explicitly (the repository
  script does). Some builders cache `node_modules` between deploys, so a
  `postinstall`-only generate can leave the bundled Prisma Client behind
  `schema.prisma` and produce enum validation errors at runtime.

NEVER edit an applied migration file, and NEVER run `prisma db push` against a
deployed database — it bypasses the migration history the next deploy relies on.

## 6. Health & observability

### Web app — `GET /api/health`

Public, no authentication, never cached. Probes the database with `SELECT 1` and
returns:

```json
{ "status": "ok", "sha": "<commit>", "deploymentId": "<id>" }
```

`sha` and `deploymentId` are populated from Railway's runtime environment and
are `null` elsewhere. The route answers `500` with `status: "error"` when the
database is unreachable — which is exactly when knowing the answering build
matters. Use it as the platform health check (radaric.pro does).

### Worker — `GET /health` on `WORKER_HEALTH_PORT` (default 3001)

```json
{
  "status": "ok",
  "gramjs": true,
  "gramjsState": "active",
  "lockWaitSeconds": 0,
  "database": true,
  "lastPollAgo": 42.1,
  "lastPollStale": false,
  "pendingItems": 0,
  "uptime": 3600,
  "errors": []
}
```

The route answers `503` when `status` is `error`, `200` otherwise.

- `gramjs: false` or `database: false` is a hard failure.
- `gramjsState: "starting"` with `lockWaitSeconds > 0` means the worker is
  waiting for a peer worker to release the Telegram session lock — expected
  during an overlapping deploy, a problem if it persists.
- `gramjsState: "invalid"` means the Telegram session was invalidated and must
  be re-authenticated in Settings → Telegram (admin).
- `status: "degraded"` means no successful story poll in the last 5 minutes. It
  can be legitimate on a quiet instance — `lastPoll` records the last processed
  story, not liveness. Treat `gramjs`/`database` as the real gates.

The worker port also serves the internal Telegram proxy endpoints the web app
uses (`/telegram/session-check`, `/telegram/channel-info`,
`/telegram/parse-channel`, `/telegram/reconnect`). These endpoints have no
authentication — NEVER publish port 3001 to the public internet. Keep it on the
private network or bound to localhost behind a proxy.

### Container health checks

The Dockerfile probes web `/api/health`; `docker-compose.yml` probes web `:3000`
**and** worker `:3001`. If you re-implement the check, cover both: a dead worker
otherwise looks healthy because the web probe alone stays green.

### Logs and error reporting

Both processes log to stdout/stderr — use the platform's log viewer. Set
`SENTRY_DSN` to forward server-side errors to Sentry; there is no browser-side
reporting.

## 7. Backups

Persistent state lives in two places: the PostgreSQL database and the media
bucket.

- **Database** — `pg_dump` is the reliable path:

  ```bash
  pg_dump "$DATABASE_URL" > radaric-$(date +%Y%m%d).sql
  psql "$DATABASE_URL" < radaric-20260101.sql   # restore
  ```

  On the Docker Compose stack, run it inside the `db` service — see
  [SELF_HOSTING.md § Backups](../SELF_HOSTING.md#backups).

- **Media bucket** — `pg_dump` does not include uploaded media. Enable bucket
  versioning, a lifecycle/replication policy, or a scheduled sync, per your
  storage provider.

Schedule backups, store them off the host, and test a restore before you need
one.

## 8. Troubleshooting

**"Can't reach database server" at boot.**
Check `DATABASE_URL`. An internal or provider-private hostname reaches the app
inside the platform network but not from your laptop; use a reachable host and
correct credentials/SSL parameters for the host you are on.

**A migration failed and the deploy is stuck.**
`scripts/migrate-safe.js` handles this at boot. To repair manually, inspect the
failed row and mark it resolved:

```bash
npx prisma migrate resolve --applied "<migration-name>"
npx prisma migrate deploy
```

NEVER use `prisma migrate reset` on a database with real data.

**Unexpected enum validation errors at runtime.**
The Prisma Client is older than `schema.prisma`. Ensure the build ran
`prisma generate` (the repository script does), or run `npx prisma generate`
and rebuild.

**Telegram sources stopped; logs show `AUTH_KEY_DUPLICATED`.**
Two live workers used the same Telegram session. The usual causes are a hard
kill during deploy (no graceful stop window), or a preview/staging environment
sharing the production database or session string. Stop the duplicate worker,
then re-authenticate the session in Settings → Telegram (admin). NEVER run a
second environment against the same session.

**Worker health is failing.**
Read `gramjsState` and `lockWaitSeconds` first (§6). `gramjsState: "starting"`
with a non-zero `lockWaitSeconds` during a deploy is normal; a persisting
`"invalid"` requires re-authentication. A worker that cannot reach the database
reports `database: false`.

**Web health returns 500.**
The web process is alive but the database probe failed — treat it as a database
incident, not an app crash.

**`next: not found` at container start.**
The entrypoint must be `sh scripts/start.sh`. The script appends
`node_modules/.bin` to `PATH` itself; an inline `next start` as the container
command can fail this way.

**Media uploads fail.**
Check all five `R2_*` variables, including `R2_PUBLIC_URL` — it is required to
build media URLs, and its absence fails uploads even when writes would succeed.

**Webhooks not arriving** (Parallel monitors).
`NEXT_PUBLIC_APP_URL` must be the correct public URL, and the Parallel webhook
secret is configured in the app's Settings, not in the environment (§2).

## Further reading

- [SELF_HOSTING.md](../SELF_HOSTING.md) — Docker Compose quick start, AI keys,
  feature→key map, updating, backups.
- [STRIPE_TESTING.md](STRIPE_TESTING.md) — optional subscription billing setup.
- [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) — Telegram credentials, authentication
  and known limitations.
- [`.env.example`](../.env.example) — every environment variable, grouped
  REQUIRED / OPTIONAL / NOT-ENV.
