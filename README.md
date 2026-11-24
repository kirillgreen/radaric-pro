# Radaric

An intelligent assistant for content curators. Radaric collects items from
hundreds of sources, filters them against your own editorial criteria with AI,
groups matching posts into stories, and learns continuously from your feedback.

Open source under AGPL-3.0: read, run, modify and self-host it, including
inside a company — see [License](#license).

## What it does

- **Collection** — RSS (with OPML bulk import), YouTube channels with
  transcript-based evaluation, Telegram (GramJS), Twitter/X (via TwitterAPI.io),
  and Parallel web monitoring for topic-level tracking.
- **AI filtering** — a global prompt plus per-source prompts, a feedback
  knowledge base, and a "run AI rules" refilter. Every decision shows its
  reasoning.
- **Story aggregation** — posts from different sources that genuinely cover the
  same event are matched and grouped into one story.
- **Curator workspace** — a Feedly-style sidebar with per-source views, light
  and dark themes, a mobile layout, and Notion export.
- **Knowledge base loop** — save passages as citations into topic collections
  and build a library whose answers the LLM keeps up to date; track a question
  and a backing monitor collects sources and maintains a cited living answer
  for it. (Whole-item saving is not currently exposed on the material
  surfaces; excerpt saving and tracked questions are.)
- **Multi-user** — full data isolation between accounts, ADMIN and USER roles,
  optional Stripe billing (bypassed in self-hosted mode).

## Stack

| Layer | Technology |
|---|---|
| App | Next.js 16 (App Router) + TypeScript, React 19 |
| Database | PostgreSQL 16 or newer + Prisma ORM |
| UI | shadcn/ui + Tailwind CSS v4 |
| AI | OpenRouter and Anthropic Claude via the Vercel AI SDK; OpenAI embeddings |
| Auth | NextAuth.js v5 + bcrypt + Google OAuth + Apple Sign In |
| Parsers | rss-parser, GramJS, TwitterAPI.io, YouTube RSS + transcripts, @mozilla/readability |
| Deployment | Railway (the hosted instance) or Docker for self-hosting |

## Quick start

The short version, with no Docker: you need Node.js 22.23.4+ (or 24.22.1+ / 26.12.1+) and a
PostgreSQL 16 or newer database.

```bash
npm install
cp .env.example .env   # then fill in the minimum set below
npm run db:migrate
npm run dev            # http://localhost:3000
```

The **first account created in an empty database becomes ADMIN** automatically;
any later account is a regular user. You can also create accounts explicitly:

```bash
node scripts/create-user.js admin 'your-password' "Admin" --admin
```

Minimum environment variables (`.env.example` groups everything by REQUIRED /
OPTIONAL and is kept in sync with the code):

- `DATABASE_URL` — PostgreSQL connection string (a direct connection, not a
  transaction-mode pooler)
- `NEXTAUTH_SECRET` — signing key (`openssl rand -hex 32`)
- `NEXT_PUBLIC_APP_URL` — the public URL of your instance
- AI configuration: `OPENROUTER_API_KEY` for the built-in defaults, a
  [custom OpenAI-compatible gateway](SELF_HOSTING.md#custom-openai-compatible-gateway),
  or `ANTHROPIC_API_KEY` with Claude models selected in **Settings → AI Settings**
  (see [AI keys](SELF_HOSTING.md#ai-keys) for which stages can use Anthropic)

Configure AI before your first feed: a feed parse runs evaluation before
insert, so without a usable model it ends in ERROR and stores nothing.

`NEXTAUTH_URL` is recommended but not required — a fallback base for reset links
and OAuth callbacks. On a non-Docker install behind a proxy, leave it unset so
NextAuth derives the host. The Docker compose file defaults it and
`NEXT_PUBLIC_APP_URL` to `http://localhost:3000`, so on a real domain set both in
`.env` (see [SELF_HOSTING.md](SELF_HOSTING.md#quick-start-docker)).

**Telegram, Parallel and Notion credentials are not environment variables.**
They live in the database and are configured in Settings (Telegram and Parallel
by an admin) — there are no `PARALLEL_API_KEY` or `PARALLEL_WEBHOOK_SECRET`
env vars.

For Docker, the production container, and the full variable list, see
[SELF_HOSTING.md](SELF_HOSTING.md) — its quick start generates the two required
secrets into `.env`. Don't copy `.env.example` for the Docker path: it leaves
`NEXTAUTH_SECRET` empty and has no `POSTGRES_PASSWORD`, so compose refuses to
start. With `.env` in place it is:

```bash
docker compose up -d --build
```

## Repository layout

| Path | What lives there |
|---|---|
| `app/` | Next.js App Router: pages, layouts and the `api/` route handlers |
| `components/` | React components; `components/ui/` holds the shadcn/ui primitives |
| `lib/` | Server and shared logic: parsers, the AI pipeline, auth, billing; the background worker is `lib/story-aggregator/worker.ts` |
| `prisma/` | Database schema and migrations |
| `scripts/` | Operator scripts (env generation, user creation, the token-encryption backfill) and the container entrypoint |
| `public/` | Static assets served as-is |
| `__tests__/` · `e2e/` | Vitest unit and integration tests · Playwright end-to-end tests |
| `docs/` | Architecture, features, API and setup guides |
| `.github/` | Contributing guide, security policy, CLA draft, CI workflows |
| `proxy.ts` · `instrumentation.ts` | Request middleware (auth gate, redirects) · server-side Sentry and boot-time checks |

The remaining root files are the tool configs (Next.js, TypeScript, PostCSS,
shadcn/ui, ESLint, Vitest, Playwright, Docker, Railway), the env template, and
the license and self-hosting docs.

## Documentation

| Doc | Contents |
|---|---|
| [SELF_HOSTING.md](SELF_HOSTING.md) | Self-hosting guide: Docker quick start, minimum env set, feature-to-key map |
| [docs/INDEX.md](docs/INDEX.md) | Documentation table of contents |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Directory layout and module annotations |
| [docs/FEATURES.md](docs/FEATURES.md) | Full feature reference and behavior contracts |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md) | REST API endpoints |
| [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) | Telegram integration setup |
| [docs/AuthSystem.md](docs/AuthSystem.md) | Auth system (NextAuth v5, sessions, OAuth) |
| [CONTRIBUTING.md](.github/CONTRIBUTING.md) | How to contribute |
| [SECURITY.md](.github/SECURITY.md) | Reporting a vulnerability (please not in a public issue) |

## License

Open source under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). You can read, run, modify and host the code yourself,
including inside a company. If you change it and let other people use your
instance over a network, section 13 of the license requires you to offer them
the complete source of your modified version. The brand and the `radaric.pro` domain are not covered by the license;
see [NOTICE](NOTICE).
