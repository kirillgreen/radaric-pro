# Contributing

Radaric is open source under the GNU Affero General Public License v3.0
(AGPL-3.0-only, see [LICENSE](../LICENSE)): you can read, run, modify and
self-host it, including inside a company. The maintainer also runs the paid
hosted service and may offer the code under other terms, so contributed code
must arrive with the right to do so: that is what the CLA grants.

## Contributions

- **Bugs and ideas:** open an issue. Clear reproduction steps — or better, a
  failing test — are the fastest path to a fix.
- **Pull requests:** open an issue first and describe the change. Before a PR
  can be merged, sign [CLA.md](CLA.md) v1.0 with a comment on the PR (the CLA
  says how).

## Development

Requirements: Node 22.23.4+ (or 24.22.1+ / 26.12.1+) and PostgreSQL 16 or newer. The Docker route is in
[SELF_HOSTING.md](../SELF_HOSTING.md).

```bash
npm ci
cp .env.example .env        # DATABASE_URL, NEXTAUTH_SECRET, NEXT_PUBLIC_APP_URL are the required three
npx prisma migrate deploy   # or `npm run db:migrate` for local development
npm run dev
```

`npm ci` installs the Husky hooks too: the pre-push hook runs `tsc` and the full
Vitest suite, so those CI steps fail on your machine first. CI also runs
`npm run build`, which pre-push runs only on `main`.

Before opening a PR:

```bash
npx tsc --noEmit
npm test        # Vitest; needs no database and no secrets
```

Conventions that reviewers will hold you to:

- Test behavior, not implementation details; a fix ships with a test that fails
  without it.
- One enum `ADD VALUE` per migration file (deploy-time migration safety).
- Use the design tokens (`app/globals.css` / Tailwind theme), never raw palette
  colors; comments explain *why*, not *what*.

## Security

Do not report vulnerabilities in public issues — see [SECURITY.md](SECURITY.md).
