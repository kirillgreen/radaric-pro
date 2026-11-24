# Self-hosting Radaric

Run Radaric on your own machine or server with your own AI keys. No Stripe, no
account with us, no telemetry to us.

The license covers the code, not the name: describe your instance as
"a Radaric instance" or "based on Radaric" if you like, but don't present it as
the Radaric service itself and don't use the logo or the `radaric.pro` domain —
see [NOTICE](NOTICE).

The code is under AGPL-3.0. Running it unchanged adds no obligation. If you
modify it and other people use your instance over the network, colleagues
included, section 13 of the license requires you to offer them the complete
source of your modified version, for example with a link to your fork.

## Quick start (Docker)

Requires Docker with the Compose plugin. From the repository root, generate its
secrets: the session key and the database password the stack refuses to boot
without, and the key that encrypts saved integration tokens:

```bash
sh scripts/generate-env.sh
```

Then start the stack:

```bash
docker compose up -d --build
```

The script writes `./.env`, is safe to re-run, and fills a key only when it is
missing or empty — a value you set is never touched. The secrets are hex on
purpose: `POSTGRES_PASSWORD` is interpolated raw into `DATABASE_URL`, and a
base64 `+` or `/` breaks that connection string. If a key is present in a shape
the script cannot safely rewrite (`KEY: value`, or `KEY=` followed by only a
`#` comment), it stops and asks you to edit that line by hand rather than
appending a second assignment.

**Never regenerate `POSTGRES_PASSWORD` once the `db-data` volume exists.**
Postgres keeps the password it was initialised with, so a new value in `.env`
makes the app fail to connect. To change it, set it in the database first, then
in `.env`:

```bash
docker compose exec db psql -U radaric -c "ALTER USER radaric PASSWORD '<new hex>'"
# then put the same value in .env and recreate the app
docker compose up -d
```

`.env` here is the compose environment file **and** is injected into the
container (`env_file`), so any key you add to it reaches the app — OpenRouter,
R2, Twitter, Resend, tuning caps. The explicit `environment:` block in
`docker-compose.yml` wins for the keys it sets (so a local-dev `DATABASE_URL`
cannot override the compose one); every other default there is overridable from
`.env`. Don't point this at a local-dev `.env`; use a fresh one for the stack.

**On a real domain, set both `NEXT_PUBLIC_APP_URL` and `NEXTAUTH_URL` in
`.env`.** They default to `http://localhost:3000`, and `NEXT_PUBLIC_APP_URL` is
what builds email links, webhook callback URLs and Stripe return URLs — left at
the default, a reset link points at your laptop.

Open <http://localhost:3000>. **The first account you create becomes the
administrator automatically** — there is no separate bootstrap step (and no
`AUTH_USER` env var; it was removed).

Configure AI **before your first feed** — `OPENROUTER_API_KEY` is the quickest
option, or use a [custom gateway](#custom-openai-compatible-gateway). See
[AI keys](#ai-keys) for Anthropic-only installs. A parse of a feed runs
evaluation before insert, so without a usable model it ends in ERROR and stores
nothing.

The compose file defaults `SELF_HOSTED=true` (every tier gate unlocked for every
account, and email verification disabled — no mail transport by design) and
`ALLOW_UNVERIFIED_SIGNUP=1` as belt-and-braces for the case where you later turn
`SELF_HOSTED` off. Both are overridable from `.env`; see
[Selling subscriptions yourself](#selling-subscriptions-yourself).

### What the container does

- Entrypoint `scripts/start.sh` as PID 1: runs migrations
  (`scripts/migrate-safe.js`), then starts the web app (port 3000) and the
  story-aggregator/Telegram worker (health port 3001, internal by default).
- `stop_grace_period: 15s` — the worker needs up to 8s to close the Telegram
  session cleanly. Do not lower it: a hard kill mid-shutdown can invalidate the
  Telegram session (`AUTH_KEY_DUPLICATED`).
- Migrations run automatically on every boot and are idempotent.
- The container healthcheck probes web `:3000/api/health` **and** worker
  `:3001/health`; if you re-implement it, keep both — a dead worker otherwise
  looks healthy. A fresh install with no Telegram answers the worker probe with
  `status: "unconfigured"` and HTTP 200, so the stack reports `healthy` before
  Telegram is configured.

### Verifying an install

`bash scripts/selfhost-e2e.sh` boots a throwaway copy of this stack under the
compose project `radaric-e2e` (a maintainer and CI check, not an operator step),
checks both health endpoints, the migration state, the first-admin sign-up, a
signed-in session and one onboarding feed served from inside the stack, then
removes the stack, its volumes and the image it built. Run it in a fresh clone,
never in the directory of a running install: the check refuses an existing
`.env` because every key in it would reach the throwaway stack
(`SELFHOST_E2E_USE_EXISTING_ENV=1` accepts that on purpose).
Port 3000 must be free, and the project name keeps the check away from a real
install on the same machine, including its `db-data` volume.

### Troubleshooting

- **Telegram sources fail and `/health` says `"unconfigured"`.** The worker
  builds no Telegram client until **both** the api id/hash/session (**Settings →
  Telegram**, admin) and a story inbox channel (**Settings → Stories**, admin)
  are set. The parse error reads `GramJS client not available`, the container
  log repeats `Worker not ready (503…)`, and `/health` on 3001 answers 200 with
  `status: "unconfigured"` — nothing is broken, there is simply no listener yet.

### Updating

```bash
git pull
docker compose up -d --build   # migrations run at boot
```

### Backups

Everything persistent lives in the `db-data` volume (Postgres). Standard
`pg_dump` inside the `db` service is the reliable path:

```bash
docker compose exec db pg_dump -U radaric radaric > radaric-backup.sql
```

## Manual install (no Docker)

Node 22.23.4+ (or 24.22.1+ / 26.12.1+), a PostgreSQL 16 or newer database, then:

```bash
npm ci
npx prisma migrate deploy
npm run build
sh scripts/start.sh
```

`scripts/start.sh` runs two processes: the web app on `PORT` (3000) and the
story-aggregator/Telegram worker on `WORKER_HEALTH_PORT` (3001).

**Keep port 3001 private.** It serves `/health` and the Telegram proxy endpoints
without authentication. Compose never publishes it; outside Docker, block it at
the firewall (or run the worker on a host/namespace the public interface cannot
reach) — nothing on 3001 should be reachable from the internet.

### Minimum environment

| Variable | Why |
|---|---|
| `DATABASE_URL` | Postgres connection string — a **direct** (session-mode) connection, never a transaction-mode pooler: the worker's Telegram session lock uses session-level advisory locks, which a transaction pooler voids |
| `NEXTAUTH_SECRET` | session signing — `openssl rand -hex 32` |
| `TOKEN_ENC_KEY` | seals saved Notion tokens at rest — `openssl rand -hex 32`; needed to save one ([docs/SECURITY.md](docs/SECURITY.md)) |
| `NEXT_PUBLIC_APP_URL` | webhook + email links; **required** in production (must be set explicitly) |
| `NEXTAUTH_URL` | recommended only; fallback for reset links / OAuth callbacks |
| AI provider configuration | see below |

Everything else is optional and documented in [`.env.example`](.env.example),
which is grouped REQUIRED / OPTIONAL / NOT-ENV and verified against the code.
Two of those optional variables change what visitors see: `CONTACT_EMAIL` is the
support, refunds and privacy address shown in the UI (unset, it shows the hosted
service's address, so set your own on a public instance), and `TRIAL_REF` turns
on the referral trial — a new account arriving with `?ref=<that value>` gets
7 days of Lite access without a card; unset or blank keeps the trial off. Both
are read per request, so a change needs no rebuild.

## AI keys

Without a custom gateway model, every stage defaults to a model routed
through **OpenRouter**, so:

- **`OPENROUTER_API_KEY`** — the zero-config choice; works for every default
  model.
- **`ANTHROPIC_API_KEY`** (or a key pasted in **Settings → AI Settings**) covers
  the direct-Anthropic models only. On its own it does not make the defaults
  work: also switch **filtering, synthesis, discovery, the Telegram story writer
  and the Telegram deduplication (matcher)** to a Claude model in
  **Settings → AI Settings**.
  Material grouping ("Group Stories") is OpenRouter-only, and onboarding feed
  extraction has no picker, so those two still need `OPENROUTER_API_KEY`. The
  dashboard banner names missing configuration for the filtering model.

Usage caps (`ROUTING_USER_DAILY_CAP`, `SELF_FILLING_CAP`, rate limits, …) stay
in force in self-hosted mode — they are spend guards, not plan limits.

### Custom OpenAI-compatible gateway

Set these in the runtime environment (`.env` for the Compose install), then
recreate the app container so both the web app and worker pick them up:

```dotenv
OPENAI_COMPATIBLE_BASE_URL=https://gateway.example.com/v1
OPENAI_COMPATIBLE_MODEL=vendor/model-id
OPENAI_COMPATIBLE_API_KEY=
```

Use the base URL, not the full endpoint path. Radaric appends `/chat/completions`.
Use the exact model ID the gateway expects. The API key is sent as a bearer token;
leave it empty for a gateway that does not require authentication. Use a gateway
you trust with feed and prompt contents; the OpenRouter data-collection policy
does not apply to custom gateways.

Setting `OPENAI_COMPATIBLE_MODEL` replaces the default for all seven AI stages,
including onboarding feed extraction and material grouping. Existing explicit
model selections are preserved. On an existing install, select **Default** for
any stages you want to move to the gateway in **Settings → AI Settings**.
You don't need an OpenRouter or Anthropic key for stages using the gateway.

The model and gateway must accept `response_format: { "type": "json_schema", … }`
on Chat Completions. A Responses-only endpoint is not supported. This setting
does not change the separate embeddings used by the optional archive integration.

## Feature → key map

| Feature | Needs | Without it |
|---|---|---|
| AI filtering / synthesis / discovery | a [custom gateway](#custom-openai-compatible-gateway), OpenRouter key for the built-in defaults, or Anthropic key with Claude selected in Settings → AI Settings | a feed parse reports ERROR and stores nothing; banner explains |
| RSS / YouTube / web pages | nothing | — |
| Behance galleries when Behance bot-checks your server | nothing (`JINA_API_KEY` optional, raises the reader's 20 req/min limit) | Behance posts keep only the feed cover |
| Telegram channels + Story Aggregator | Telegram api id/hash/session in **Settings → Telegram** (admin) **and** a story inbox channel on an admin account (**Settings → Stories**) | the worker builds no Telegram client; Telegram sources fail with "GramJS client not available" |
| Twitter/X | `TWITTER_API_IO_KEY` | X sources report ERROR |
| Parallel web monitoring / tracked questions | Parallel key + webhook secret in **Settings** | tracked questions unavailable |
| Notion export | Notion token per user in **Settings** | export buttons hidden |
| Story Aggregator → Notion | admin token + story database (see the property schema in [StoryAggregator.md](docs/StoryAggregator.md#notion-output)) | stories stay in the dashboard |
| Email verification / password reset | `RESEND_API_KEY` and `EMAIL_FROM` on a domain verified in your Resend account | see `ALLOW_UNVERIFIED_SIGNUP` above; reset mail is never delivered |
| Media (Telegram photos, thumbnails) | Cloudflare R2 (`R2_*`) | posts render without images |
| Related-material linking (optional external PostgreSQL archive) | `ARCHIVE_DATABASE_URL` + `OPENAI_API_KEY` | feature returns nothing |

**Telegram, Parallel and Notion credentials are NOT environment variables.**
They are stored in the database and set in the app's Settings UI — see the
"NOT ENV VARS" section of `.env.example`. This trips up most first attempts.

## Single-user vs multi-user

- **Single-user**: do nothing on the compose stack, where `SELF_HOSTED` already
  defaults to true. First account = ADMIN, which already unlocks every
  subscription and verification gate. A manual install without the flag still
  serves the hosted public pages, so set it or replace those pages (see below).
- **Multi-user**: set `SELF_HOSTED=true` so ordinary accounts are unlocked too.
  Additional accounts: `node scripts/create-user.js <user> <pass>` (add
  `--admin` for another operator), or grant time-limited Lite access from the
  admin dashboard (access without Twitter).

With `SELF_HOSTED` on, the public pages follow it: `/` redirects to the sign-in
page, and `/terms` and `/privacy` render short neutral pages saying the operator
is responsible for the terms and privacy practices — replace them with your own.
**A single-user install without the flag shows the hosted landing page** (with
its hosted prices and the `radaric.pro` contact address), so either set the flag
or replace the pages.

## Verification status of this guide

The compose contract (PID 1, ports 3000/3001, 15s grace, required secrets,
`.env` not baked into the image) is pinned by `__tests__/docker-contract.test.ts`,
which also executes `scripts/generate-env.sh` in a temporary directory, and
`scripts/selfhost-e2e.sh` runs the quick start end-to-end in CI. If something in
the quick start fails, that is a bug in these docs; please report it.

## Selling subscriptions yourself

Set the four `STRIPE_*` price variables plus the two secrets **and drop
`SELF_HOSTED` to `false` in `.env`** — compose defaults it to `true`, and while
it is true billing is disabled for every account whatever Stripe keys exist. To
require email verification, also set `ALLOW_UNVERIFIED_SIGNUP=0` (an empty value
keeps the compose default of `1`) and configure `RESEND_API_KEY` + `EMAIL_FROM`.
With that, the tier gates return; the code is unchanged between self-host and
hosted. See `docs/STRIPE_TESTING.md` for the Stripe-side setup.

**Turning `SELF_HOSTED` off switches the public pages back to the hosted ones**:
`/` serves the hosted Radaric landing page, and `/terms` and `/privacy` serve the
hosted terms and privacy policy — the licensor's name, the hosted prices and our
contact address. Replace `app/page.tsx`,
`app/(landing)/terms/page.tsx` and `app/(landing)/privacy/page.tsx` before you
sell anything; [Single-user vs multi-user](#single-user-vs-multi-user) describes
the same switch from the other side.
